"""
Backend de la Matriz de Recupero.
Expone un único endpoint POST /upload que recibe los 5 Excel, guarda una copia
en disco y devuelve la respuesta AL INSTANTE — el procesamiento pesado
(pandas + guardado en Supabase) corre después, en segundo plano. Esto evita
que un proxy/balanceador corte la conexión por tardar demasiado en responder
(un problema real con Cartera/Recupero de cientos de MB).

Variables de entorno necesarias (ver .env.example):
  SUPABASE_URL       -> URL del proyecto (Settings > API, o botón "Connect")
  SUPABASE_ANON_KEY  -> anon/publishable key (Settings > API Keys, o botón "Connect")
  SUPABASE_DB_URL    -> connection string de Postgres (botón "Connect" > pestaña ORM/URI)
  ALLOWED_ORIGINS    -> URL del frontend (para CORS), separadas por coma
"""
import os
import shutil
import tempfile
import datetime
from typing import List
import httpx
import pandas as pd
import psycopg2
import psycopg2.extras
from fastapi import FastAPI, UploadFile, File, Form, Header, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware

import logica_matriz as lm
import logica_incremental as li

app = FastAPI(title="Matriz Recupero API")

ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_ANON_KEY = os.environ["SUPABASE_ANON_KEY"]
SUPABASE_DB_URL = os.environ["SUPABASE_DB_URL"]


def verificar_usuario(authorization: str = Header(None)) -> str:
    """Valida la sesión llamando directamente al endpoint de Auth de Supabase
    (en vez de decodificar el JWT a mano). Esto funciona sin importar si el
    proyecto firma sus tokens con el esquema viejo (HS256) o el nuevo
    (claves asimétricas), porque es el propio Supabase el que lo verifica."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Falta el token de autenticación")
    token = authorization.split(" ", 1)[1]
    try:
        resp = httpx.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={"Authorization": f"Bearer {token}", "apikey": SUPABASE_ANON_KEY},
            timeout=10,
        )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"No se pudo validar la sesión con Supabase: {type(e).__name__}: {e}")
    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail=f"Token inválido o vencido (Supabase respondió {resp.status_code}: {resp.text[:200]})")
    return resp.json().get("email", "desconocido")


def obtener_conexion():
    # connect_timeout evita que la conexión se quede colgada indefinidamente
    # si el pooler de Supabase no responde — mejor que falle rápido y quede
    # registrado, a que el servicio entero parezca "trabado".
    return psycopg2.connect(SUPABASE_DB_URL, connect_timeout=15)


@app.get("/health")
def health():
    return {"status": "ok"}


def _copiar_a_temp(upload_file: UploadFile) -> str:
    """Copia el archivo subido a un temporal en disco que sobrevive más allá
    de esta request (necesario porque el archivo de FastAPI se borra apenas
    termina la request, pero el procesamiento real corre después, en segundo
    plano)."""
    sufijo = os.path.splitext(upload_file.filename or "archivo.xlsx")[1] or ".xlsx"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=sufijo)
    with tmp:
        shutil.copyfileobj(upload_file.file, tmp, length=1024 * 1024)
    return tmp.name


@app.post("/upload")
async def upload(
    background_tasks: BackgroundTasks,
    cartera: UploadFile = File(...),
    recupero: UploadFile = File(...),
    juzgados: UploadFile = File(...),
    abogados: UploadFile = File(...),
    pasos: UploadFile = File(...),
    authorization: str = Header(None),
):
    usuario = verificar_usuario(authorization)

    for f in (cartera, recupero, juzgados, abogados, pasos):
        await f.seek(0)

    # Copiar los 5 archivos a temporales en disco AHORA (mientras la request
    # sigue viva) — el procesamiento pesado se dispara después, en background.
    try:
        ruta_cartera = _copiar_a_temp(cartera)
        ruta_recupero = _copiar_a_temp(recupero)
        ruta_juzgados = _copiar_a_temp(juzgados)
        ruta_abogados = _copiar_a_temp(abogados)
        ruta_pasos = _copiar_a_temp(pasos)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error recibiendo los archivos: {e}")

    _log_carga(usuario, "procesando", "Archivos recibidos, procesando en segundo plano...")
    background_tasks.add_task(
        _procesar_en_segundo_plano,
        usuario, ruta_cartera, ruta_recupero, ruta_juzgados, ruta_abogados, ruta_pasos,
    )

    return {
        "status": "procesando",
        "mensaje": "Los archivos se recibieron correctamente. Se están procesando en el servidor — puede tardar varios minutos. Revisá el Historial de Cargas para ver cuándo termina.",
    }


def _procesar_en_segundo_plano(usuario, ruta_cartera, ruta_recupero, ruta_juzgados, ruta_abogados, ruta_pasos):
    try:
        try:
            df_mensual, df_base, df_recupero_diario, df_recupero_diario_detalle, df_pasos_detalle = lm.procesar(
                archivo_cartera=ruta_cartera,
                archivo_recupero=ruta_recupero,
                archivo_juzgados=ruta_juzgados,
                archivo_abogados=ruta_abogados,
                archivo_pasos=ruta_pasos,
            )
        except Exception as e:
            _log_carga(usuario, "error", f"Error procesando los archivos: {e}")
            return

        try:
            _guardar_en_supabase(df_mensual, df_base, df_recupero_diario, df_recupero_diario_detalle, df_pasos_detalle)
        except Exception as e:
            _log_carga(usuario, "error", f"Error guardando en la base: {e}")
            return

        _log_carga(usuario, "ok", f"{len(df_mensual)} filas mensuales, {len(df_base)} filas base gral")
    finally:
        for ruta in (ruta_cartera, ruta_recupero, ruta_juzgados, ruta_abogados, ruta_pasos):
            try:
                os.remove(ruta)
            except OSError:
                pass


def _log_carga(usuario, estado, mensaje):
    try:
        conn = obtener_conexion()
        with conn, conn.cursor() as cur:
            cur.execute(
                "insert into cargas_log (archivo, subido_por, estado, mensaje) values (%s, %s, %s, %s)",
                ("carga_mensual", usuario, estado, mensaje),
            )
        conn.close()
    except Exception as e:
        # Antes esto se tragaba el error en silencio. Ahora al menos queda
        # visible en los Logs de Render para poder diagnosticarlo.
        print(f"[ERROR _log_carga] No se pudo escribir en cargas_log: {type(e).__name__}: {e}", flush=True)


def _guardar_en_supabase(df_mensual, df_base, df_recupero_diario, df_recupero_diario_detalle, df_pasos_detalle):
    print(f"[GUARDADO] iniciando — {len(df_mensual)} filas mensuales, {len(df_base)} filas base gral a guardar", flush=True)
    print("[GUARDADO] conectando a Postgres...", flush=True)
    conn = obtener_conexion()
    print("[GUARDADO] conexión OK", flush=True)
    try:
        with conn, conn.cursor() as cur:
            cur.execute("select id, nombre from estudios")
            mapa_estudio_id = {nombre: id_ for id_, nombre in cur.fetchall()}
            print(f"[GUARDADO] {len(mapa_estudio_id)} estudios leídos de la tabla estudios", flush=True)

            filas_mensual = [
                (mapa_estudio_id[r.estudio], r.mes, r.parametro, r.valor)
                for r in df_mensual.itertuples()
                if r.estudio in mapa_estudio_id
            ]
            print(f"[GUARDADO] insertando {len(filas_mensual)} filas en matriz_mensual...", flush=True)
            psycopg2.extras.execute_values(
                cur,
                """
                insert into matriz_mensual (estudio_id, mes, parametro, valor)
                values %s
                on conflict (estudio_id, mes, parametro)
                do update set valor = excluded.valor, actualizado_en = now()
                """,
                filas_mensual,
                page_size=500,
            )
            print("[GUARDADO] matriz_mensual OK", flush=True)

            filas_base = [
                (mapa_estudio_id[r.estudio], r.parametro, r.valor)
                for r in df_base.itertuples()
                if r.estudio in mapa_estudio_id
            ]
            print(f"[GUARDADO] insertando {len(filas_base)} filas en base_gral...", flush=True)
            psycopg2.extras.execute_values(
                cur,
                """
                insert into base_gral (estudio_id, parametro, valor)
                values %s
                on conflict (estudio_id, parametro)
                do update set valor = excluded.valor, actualizado_en = now()
                """,
                filas_base,
                page_size=500,
            )
            print("[GUARDADO] base_gral OK", flush=True)

            filas_diario = [
                (mapa_estudio_id[r.estudio], r.fecha, r.valor, r.valor_judicial, r.valor_extrajudicial, r.cantidad_fichas, r.valor_cfn, r.cantidad_cfn, r.valor_em, r.cantidad_em, r.valor_confina, r.cantidad_confina)
                for r in df_recupero_diario.itertuples()
                if r.estudio in mapa_estudio_id
            ]
            print(f"[GUARDADO] insertando {len(filas_diario)} filas en recupero_diario...", flush=True)
            if filas_diario:
                psycopg2.extras.execute_values(
                    cur,
                    """
                    insert into recupero_diario (estudio_id, fecha, valor, valor_judicial, valor_extrajudicial, cantidad_fichas,
                                                  valor_cfn, cantidad_cfn, valor_em, cantidad_em, valor_confina, cantidad_confina)
                    values %s
                    on conflict (estudio_id, fecha)
                    do update set valor = excluded.valor, valor_judicial = excluded.valor_judicial,
                        valor_extrajudicial = excluded.valor_extrajudicial, cantidad_fichas = excluded.cantidad_fichas,
                        valor_cfn = excluded.valor_cfn, cantidad_cfn = excluded.cantidad_cfn,
                        valor_em = excluded.valor_em, cantidad_em = excluded.cantidad_em,
                        valor_confina = excluded.valor_confina, cantidad_confina = excluded.cantidad_confina,
                        actualizado_en = now()
                    """,
                    filas_diario,
                    page_size=500,
                )
            print("[GUARDADO] recupero_diario OK", flush=True)

            filas_detalle = [
                (mapa_estudio_id[r.estudio], r.fecha, r.compania, r.tipo, r.valor, r.cantidad_fichas)
                for r in df_recupero_diario_detalle.itertuples()
                if r.estudio in mapa_estudio_id
            ]
            print(f"[GUARDADO] insertando {len(filas_detalle)} filas en recupero_diario_detalle...", flush=True)
            if filas_detalle:
                psycopg2.extras.execute_values(
                    cur,
                    """
                    insert into recupero_diario_detalle (estudio_id, fecha, compania, tipo, valor, cantidad_fichas)
                    values %s
                    on conflict (estudio_id, fecha, compania, tipo)
                    do update set valor = excluded.valor, cantidad_fichas = excluded.cantidad_fichas, actualizado_en = now()
                    """,
                    filas_detalle,
                    page_size=500,
                )
            print("[GUARDADO] recupero_diario_detalle OK", flush=True)

            filas_pasos_detalle = [
                (mapa_estudio_id[r.estudio], r.mes, r.compania, r.metrica, r.cantidad_fichas)
                for r in df_pasos_detalle.itertuples()
                if r.estudio in mapa_estudio_id
            ]
            print(f"[GUARDADO] insertando {len(filas_pasos_detalle)} filas en pasos_mensual_detalle...", flush=True)
            if filas_pasos_detalle:
                psycopg2.extras.execute_values(
                    cur,
                    """
                    insert into pasos_mensual_detalle (estudio_id, mes, compania, metrica, cantidad_fichas)
                    values %s
                    on conflict (estudio_id, mes, compania, metrica)
                    do update set cantidad_fichas = excluded.cantidad_fichas, actualizado_en = now()
                    """,
                    filas_pasos_detalle,
                    page_size=500,
                )
            print("[GUARDADO] pasos_mensual_detalle OK", flush=True)
    finally:
        conn.close()


# =====================================================================
# MODO INCREMENTAL: altas/bajas de Cartera + Recupero/Pasos de un solo mes
# =====================================================================

@app.post("/backfill-cancelados")
async def backfill_cancelados(
    background_tasks: BackgroundTasks,
    archivo: UploadFile = File(...),
    authorization: str = Header(None),
):
    """Da de baja (cancela) las fichas del archivo — mismo efecto que una
    baja en la carga mensual normal, pero con su propio archivo dedicado,
    sin pasar por el formulario completo con altas/Recupero/Pasos."""
    usuario = verificar_usuario(authorization)
    await archivo.seek(0)
    try:
        ruta = _copiar_a_temp(archivo)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error recibiendo el archivo: {e}")

    _log_carga(usuario, "procesando", "Cancelados recibido, procesando en segundo plano...")
    background_tasks.add_task(_procesar_cancelados, usuario, ruta)
    return {"status": "procesando", "mensaje": "Procesando las bajas por cancelación..."}


# =====================================================================
# ÚLTIMO PASO PROCESAL POR CAUSA (para caducidad / días sin movimiento)
# =====================================================================

def _actualizar_ultimo_paso(cur, df):
    """Actualiza cartera_causas.fecha_ultimo_paso / ultimo_paso con el paso más
    reciente de cada ficha. Solo escribe si la fecha del archivo es más nueva
    que la guardada (o no había ninguna), para no reescribir filas sin cambios (se pueden cargar los meses en cualquier orden).
    Devuelve cuántas fichas se actualizaron."""
    if df is None or df.empty:
        return 0
    filas = [(r.ficha, r.fecha_ultimo_paso, r.ultimo_paso) for r in df.itertuples()]
    actualizadas = 0
    for i in range(0, len(filas), 5000):
        lote = filas[i:i + 5000]
        psycopg2.extras.execute_values(
            cur,
            """
            update cartera_causas c
               set fecha_ultimo_paso = v.f, ultimo_paso = v.p
              from (values %s) as v(ficha, f, p)
             where c.ficha = v.ficha
               and (c.fecha_ultimo_paso is null or v.f > c.fecha_ultimo_paso)
            """,
            lote,
            template="(%s, %s::date, %s)",
            page_size=len(lote),
        )
        actualizadas += max(cur.rowcount, 0)
    return actualizadas


@app.post("/cargar-ultimo-paso")
async def cargar_ultimo_paso(
    background_tasks: BackgroundTasks,
    archivos: List[UploadFile] = File(...),
    authorization: str = Header(None),
):
    """Carga uno o varios archivos de Pasos Procesales (por ejemplo abril a
    septiembre) y guarda, para cada ficha, la fecha y el tipo de su último
    paso. No toca los conteos mensuales de pasos ni ninguna otra tabla."""
    usuario = verificar_usuario(authorization)
    rutas = []
    try:
        for a in archivos:
            await a.seek(0)
            rutas.append((a.filename or "archivo", _copiar_a_temp(a)))
    except Exception as e:
        for _, r in rutas:
            try:
                os.remove(r)
            except OSError:
                pass
        raise HTTPException(status_code=400, detail=f"Error recibiendo los archivos: {e}")

    _log_carga(usuario, "procesando", f"Último paso procesal: {len(rutas)} archivo(s) recibido(s), procesando...")
    background_tasks.add_task(_procesar_ultimo_paso, usuario, rutas)
    return {"status": "procesando", "mensaje": "Procesando los pasos procesales..."}


def _procesar_ultimo_paso(usuario, rutas):
    try:
        try:
            # Se leen todos los archivos y se combinan ANTES de escribir, así cada
            # ficha se actualiza una sola vez (con su paso más reciente de todos).
            partes, detalle = [], []
            for nombre, ruta in rutas:
                df = li.leer_ultimo_paso_archivo(ruta)
                detalle.append(f"{nombre}: {len(df)} fichas")
                print(f"[ULTIMO-PASO] {nombre}: {len(df)} fichas en el archivo", flush=True)
                partes.append(df)
            df_todo = pd.concat(partes, ignore_index=True)
            df_todo['_orden'] = range(len(df_todo))
            df_todo = (df_todo.sort_values(['ficha', 'fecha_ultimo_paso', '_orden'])
                       .groupby('ficha', as_index=False).tail(1)[['ficha', 'fecha_ultimo_paso', 'ultimo_paso']])
            conn = obtener_conexion()
            try:
                with conn, conn.cursor() as cur:
                    n = _actualizar_ultimo_paso(cur, df_todo)
            finally:
                conn.close()
        except Exception as e:
            _log_carga(usuario, "error", f"Error cargando el último paso: {e}")
            return
        _log_carga(usuario, "ok", f"Último paso procesal cargado: {len(df_todo)} fichas distintas en {len(rutas)} archivo(s), {n} actualizadas — " + "; ".join(detalle))
    finally:
        for _, ruta in rutas:
            try:
                os.remove(ruta)
            except OSError:
                pass


def _recalcular_resumenes_desde_cartera(cur):
    """Recalcula base_gral, base_gral_por_compania y base_gral_por_estudio_compania
    a partir del estado actual de cartera_causas (activas + inactivas), conservando
    el valor ya guardado de RECUPERO ULT.MES CERRADO en cada tabla."""
    estudios_validos = _obtener_estudios_validos()
    cur.execute("select id, nombre from estudios")
    mapa_estudio_id = {nombre: id_ for id_, nombre in cur.fetchall()}

    cur.execute("""
        select cc.ficha, e.nombre as estudio, cc.compania, cc.nro_expediente, cc.juzgado, cc.nivel, cc.empresa,
               cc.embargo, cc.deuda_total, cc.mto_total_pagos, cc.fecha_inicio_estudio,
               cc.fecha_ultimo_pago, cc.activa
        from cartera_causas cc
        join estudios e on e.id = cc.estudio_id
    """)
    columnas = ['ficha', 'estudio', 'compania', 'nro_expediente', 'juzgado', 'nivel', 'empresa', 'embargo',
                'deuda_total', 'mto_total_pagos', 'fecha_inicio_estudio', 'fecha_ultimo_pago', 'activa']
    df_completa = pd.DataFrame(cur.fetchall(), columns=columnas)

    # base_gral (por estudio)
    cur.execute("""
        select e.nombre, bg.valor from base_gral bg join estudios e on e.id = bg.estudio_id
        where bg.parametro = 'RECUPERO ULT.MES CERRADO'
    """)
    rec_estudio = {n: float(v) for n, v in cur.fetchall()}
    df_base = li.calcular_base_gral_desde_cartera(df_completa, rec_estudio, estudios_validos)
    filas = [(mapa_estudio_id[r.estudio], r.parametro, r.valor) for r in df_base.itertuples() if r.estudio in mapa_estudio_id]
    if filas:
        psycopg2.extras.execute_values(
            cur,
            """insert into base_gral (estudio_id, parametro, valor) values %s
               on conflict (estudio_id, parametro) do update set valor = excluded.valor, actualizado_en = now()""",
            filas, page_size=500,
        )

    # base_gral_por_compania (nacional)
    cur.execute("select compania, valor from base_gral_por_compania where parametro = 'RECUPERO ULT.MES CERRADO'")
    rec_comp = {c: float(v) for c, v in cur.fetchall()}
    df_comp = li.calcular_base_gral_por_compania(df_completa, rec_comp)
    filas = [(r.compania, r.parametro, r.valor) for r in df_comp.itertuples()]
    if filas:
        psycopg2.extras.execute_values(
            cur,
            """insert into base_gral_por_compania (compania, parametro, valor) values %s
               on conflict (compania, parametro) do update set valor = excluded.valor, actualizado_en = now()""",
            filas, page_size=500,
        )

    # base_gral_por_estudio_compania
    cur.execute("""
        select e.nombre, bgc.compania, bgc.valor from base_gral_por_estudio_compania bgc
        join estudios e on e.id = bgc.estudio_id where bgc.parametro = 'RECUPERO ULT.MES CERRADO'
    """)
    rec_ec = {(n, c): float(v) for n, c, v in cur.fetchall()}
    df_ec = li.calcular_base_gral_por_estudio_y_compania(df_completa, rec_ec, estudios_validos)
    filas = [(mapa_estudio_id[r.estudio], r.compania, r.parametro, r.valor) for r in df_ec.itertuples() if r.estudio in mapa_estudio_id]
    if filas:
        psycopg2.extras.execute_values(
            cur,
            """insert into base_gral_por_estudio_compania (estudio_id, compania, parametro, valor) values %s
               on conflict (estudio_id, compania, parametro) do update set valor = excluded.valor, actualizado_en = now()""",
            filas, page_size=500,
        )


def _procesar_cancelados(usuario, ruta):
    """Carga de juicios cancelados (archivo con el formato de Cartera).
    - Las fichas que YA están en cartera_causas pasan a inactivas (salen de gestión).
    - Las que no están se insertan como inactivas, para que cuenten en CANCELADAS
      (por estudio, por empresa y total). Es solo estadístico.
    - La fecha de cancelación es la 'Fecha Ultimo Pago' del archivo."""
    try:
        try:
            print("[CANCELADOS] leyendo archivo...", flush=True)
            dict_je, dict_js = _resolver_y_guardar_diccionarios(None, None)
            df = li.procesar_cancelados_archivo(ruta, dict_je, dict_js)
            print(f"[CANCELADOS] {len(df)} fichas en el archivo", flush=True)
        except Exception as e:
            _log_carga(usuario, "error", f"Error procesando Cancelados: {e}")
            return

        try:
            conn = obtener_conexion()
            try:
                with conn, conn.cursor() as cur:
                    cur.execute("select id, nombre from estudios")
                    mapa_estudio_id = {nombre: id_ for id_, nombre in cur.fetchall()}
                    fichas = df['ficha'].tolist()
                    cur.execute("select ficha from cartera_causas where ficha = ANY(%s) and activa = true", (fichas,))
                    ya_activas = len(cur.fetchall())
                    cur.execute("select count(*) from cartera_causas where ficha = ANY(%s)", (fichas,))
                    ya_existentes = cur.fetchone()[0]

                    filas = [
                        (r.ficha, mapa_estudio_id.get(r.estudio), r.compania, r.nro_expediente, r.exp_nro_mpr, r.juzgado,
                         r.cod_abo_encargado, r.nivel, r.empresa, r.embargo, r.deuda_total, r.mto_total_pagos,
                         r.fecha_inicio_estudio, r.fecha_ultimo_pago, r.fecha_baja)
                        for r in df.itertuples() if mapa_estudio_id.get(r.estudio) is not None
                    ]
                    print(f"[CANCELADOS] {ya_existentes} ya existen en la base ({ya_activas} activas), {len(filas) - ya_existentes} nuevas", flush=True)
                    psycopg2.extras.execute_values(
                        cur,
                        """
                        insert into cartera_causas
                            (ficha, estudio_id, compania, nro_expediente, exp_nro_mpr, juzgado, cod_abo_encargado,
                             nivel, empresa, embargo, deuda_total, mto_total_pagos, fecha_inicio_estudio, fecha_ultimo_pago,
                             fecha_baja, activa)
                        values %s
                        on conflict (ficha) do update set
                            activa = false,
                            fecha_baja = coalesce(excluded.fecha_baja, cartera_causas.fecha_baja, now())
                        """,
                        filas,
                        template="(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,false)",
                        page_size=1000,
                    )
                    print("[CANCELADOS] recalculando resúmenes (estudio, empresa, estudio x empresa)...", flush=True)
                    _recalcular_resumenes_desde_cartera(cur)
            finally:
                conn.close()
        except Exception as e:
            _log_carga(usuario, "error", f"Error guardando Cancelados: {e}")
            return

        _log_carga(usuario, "ok", f"Cancelados: {len(filas)} fichas ({ya_activas} pasaron de activas a canceladas, {len(filas) - ya_existentes} nuevas)")
    finally:
        try:
            os.remove(ruta)
        except OSError:
            pass


@app.post("/backfill-estudio")
async def backfill_estudio(
    background_tasks: BackgroundTasks,
    archivo: UploadFile = File(...),
    authorization: str = Header(None),
):
    """Corrige el estudio de causas puntuales por Ficha + Sucursal (un reporte
    de tu sistema origen) — pisa el estudio_id calculado por abogado/juzgado
    SOLO para las fichas que vengan en el archivo, y solo si la causa sigue
    activa. Las causas dadas de baja no se tocan. Pensado para casos como el
    abogado dueño del estudio (código ambiguo) donde el cálculo automático
    por juzgado no siempre acierta la sucursal real."""
    usuario = verificar_usuario(authorization)
    await archivo.seek(0)
    try:
        ruta = _copiar_a_temp(archivo)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error recibiendo el archivo: {e}")

    _log_carga(usuario, "procesando", "Backfill de Estudio recibido, procesando en segundo plano...")
    background_tasks.add_task(_procesar_backfill_estudio, usuario, ruta)
    return {"status": "procesando", "mensaje": "Actualizando el estudio de las causas indicadas..."}


def _procesar_backfill_estudio(usuario, ruta):
    try:
        try:
            print("[BACKFILL-ESTUDIO] leyendo archivo...", flush=True)
            dict_hojas = lm.leer_tabla_grande(ruta, dtype={'Ficha': str})
            df = pd.concat(dict_hojas.values(), ignore_index=True)
            col_sucursal = lm.encontrar_columna(
                df.columns, ['Sucursal', 'Estudio', 'Sucursal Estudio', 'Sucursal del Estudio'],
                palabras_clave_alguna=['sucursal', 'estudio'],
            )
            if 'Ficha' not in df.columns or not col_sucursal:
                raise ValueError("El archivo necesita las columnas 'Ficha' y 'Sucursal' (o 'Estudio').")
            df['_ficha'] = df['Ficha'].astype(str).str.strip()
            df['_estudio_norm'] = df[col_sucursal].astype(str).map(lm.normalizar_texto)
            df = df[df['_ficha'] != ''].drop_duplicates(subset='_ficha', keep='last')
            filas_archivo = list(zip(df['_ficha'], df['_estudio_norm']))
            print(f"[BACKFILL-ESTUDIO] {len(filas_archivo)} fichas en el archivo", flush=True)
        except Exception as e:
            _log_carga(usuario, "error", f"Error procesando el backfill: {e}")
            return

        try:
            conn = obtener_conexion()
            try:
                with conn, conn.cursor() as cur:
                    cur.execute("select id, nombre from estudios")
                    mapa_estudio_id = {nombre: id_ for id_, nombre in cur.fetchall()}

                    filas_validas = [
                        (mapa_estudio_id[estudio], ficha)
                        for ficha, estudio in filas_archivo
                        if estudio in mapa_estudio_id
                    ]
                    no_reconocidos = sorted({estudio for _, estudio in filas_archivo if estudio not in mapa_estudio_id})
                    if no_reconocidos:
                        print(f"[BACKFILL-ESTUDIO] AVISO: sucursales no reconocidas en el archivo, se ignoran esas filas: {no_reconocidos}", flush=True)

                    print(f"[BACKFILL-ESTUDIO] actualizando estudio para {len(filas_validas)} fichas (solo las activas)...", flush=True)
                    actualizadas = 0
                    if filas_validas:
                        psycopg2.extras.execute_values(
                            cur,
                            """
                            update cartera_causas as cc set estudio_id = v.estudio_id
                            from (values %s) as v(estudio_id, ficha)
                            where cc.ficha = v.ficha and cc.activa = true
                            """,
                            filas_validas,
                            page_size=1000,
                        )
                        actualizadas = cur.rowcount

                    print("[BACKFILL-ESTUDIO] recalculando base_gral...", flush=True)
                    # Guardamos el Recupero ya cargado para no pisarlo con 0 al
                    # recalcular (este backfill no sube Recupero, solo mueve causas).
                    cur.execute("""
                        select e.nombre, bg.valor from base_gral bg
                        join estudios e on e.id = bg.estudio_id
                        where bg.parametro = 'RECUPERO ULT.MES CERRADO'
                    """)
                    recupero_por_estudio = {nombre: float(valor) for nombre, valor in cur.fetchall()}

                    cur.execute("""
                        select cc.ficha, e.nombre as estudio, cc.nro_expediente, cc.juzgado, cc.nivel, cc.empresa,
                               cc.embargo, cc.deuda_total, cc.mto_total_pagos, cc.fecha_inicio_estudio,
                               cc.fecha_ultimo_pago, cc.activa
                        from cartera_causas cc
                        join estudios e on e.id = cc.estudio_id
                    """)
                    columnas = ['ficha', 'estudio', 'nro_expediente', 'juzgado', 'nivel', 'empresa', 'embargo',
                                'deuda_total', 'mto_total_pagos', 'fecha_inicio_estudio', 'fecha_ultimo_pago', 'activa']
                    df_cartera_completa_be = pd.DataFrame(cur.fetchall(), columns=columnas)

                    df_base = li.calcular_base_gral_desde_cartera(df_cartera_completa_be, recupero_por_estudio)
                    filas_base = [
                        (mapa_estudio_id[r.estudio], r.parametro, r.valor)
                        for r in df_base.itertuples() if r.estudio in mapa_estudio_id
                    ]
                    if filas_base:
                        psycopg2.extras.execute_values(
                            cur,
                            """
                            insert into base_gral (estudio_id, parametro, valor)
                            values %s
                            on conflict (estudio_id, parametro)
                            do update set valor = excluded.valor, actualizado_en = now()
                            """,
                            filas_base,
                            page_size=500,
                        )
            finally:
                conn.close()
        except Exception as e:
            _log_carga(usuario, "error", f"Error guardando el backfill: {e}")
            return

        mensaje_final = f"Backfill de Estudio: {actualizadas} causas reasignadas"
        if no_reconocidos:
            mensaje_final += f" (sucursales no reconocidas ignoradas: {', '.join(no_reconocidos)})"
        _log_carga(usuario, "ok", mensaje_final)
    finally:
        try:
            os.remove(ruta)
        except OSError:
            pass


@app.post("/backfill-compania")
async def backfill_compania(
    background_tasks: BackgroundTasks,
    archivo: UploadFile = File(...),
    authorization: str = Header(None),
):
    """Actualiza SOLO la columna 'compania' de las causas que ya existen en
    cartera_causas (identificadas por Ficha), sin reprocesar nada más.
    Pensado para cuando se agrega un campo nuevo al sistema y no hace falta
    resubir toda la Cartera completa por el circuito de altas/bajas normal."""
    usuario = verificar_usuario(authorization)
    await archivo.seek(0)
    try:
        ruta = _copiar_a_temp(archivo)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error recibiendo el archivo: {e}")

    _log_carga(usuario, "procesando", "Backfill de Compania recibido, procesando en segundo plano...")
    background_tasks.add_task(_procesar_backfill_compania, usuario, ruta)
    return {"status": "procesando", "mensaje": "Actualizando la compañía de las causas existentes..."}


def _procesar_backfill_compania(usuario, ruta):
    try:
        try:
            print("[BACKFILL] leyendo archivo...", flush=True)
            dict_hojas = lm.leer_tabla_grande(ruta, dtype={'Ficha': str})
            df = pd.concat(dict_hojas.values(), ignore_index=True)
            if 'Ficha' not in df.columns or 'Compania' not in df.columns:
                raise ValueError("El archivo necesita las columnas 'Ficha' y 'Compania'.")
            df['_ficha'] = df['Ficha'].astype(str).str.strip()
            df['_compania'] = df['Compania'].apply(li.normalizar_compania)
            df = df[df['_ficha'] != ''].drop_duplicates(subset='_ficha', keep='last')
            filas = list(zip(df['_ficha'], df['_compania']))
            print(f"[BACKFILL] {len(filas)} fichas con compañía a actualizar", flush=True)
        except Exception as e:
            _log_carga(usuario, "error", f"Error procesando el backfill: {e}")
            return

        try:
            conn = obtener_conexion()
            try:
                with conn, conn.cursor() as cur:
                    if filas:
                        psycopg2.extras.execute_values(
                            cur,
                            """
                            update cartera_causas as cc set compania = v.compania
                            from (values %s) as v(ficha, compania)
                            where cc.ficha = v.ficha
                            """,
                            filas,
                            page_size=1000,
                        )
                    print("[BACKFILL] compania actualizada, recalculando base_gral_por_compania...", flush=True)

                    cur.execute("""
                        select cc.ficha, e.nombre as estudio, cc.compania, cc.nro_expediente, cc.juzgado,
                               cc.nivel, cc.empresa, cc.embargo, cc.deuda_total, cc.mto_total_pagos,
                               cc.fecha_inicio_estudio, cc.fecha_ultimo_pago, cc.activa
                        from cartera_causas cc
                        join estudios e on e.id = cc.estudio_id
                    """)
                    columnas = ['ficha', 'estudio', 'compania', 'nro_expediente', 'juzgado', 'nivel', 'empresa',
                                'embargo', 'deuda_total', 'mto_total_pagos', 'fecha_inicio_estudio', 'fecha_ultimo_pago', 'activa']
                    df_cartera_completa_bc = pd.DataFrame(cur.fetchall(), columns=columnas)

                    # RECUPERO ULT.MES CERRADO por compañía queda en 0 hasta la
                    # próxima carga mensual normal (necesita un mes puntual, y
                    # este backfill no sube Recupero) — el resto de los KPIs
                    # (En Gestión, Iniciadas, Con Embargo, etc.) sí quedan bien.
                    df_base_compania = li.calcular_base_gral_por_compania(df_cartera_completa_bc, {})
                    filas_base_compania = [(r.compania, r.parametro, r.valor) for r in df_base_compania.itertuples()]
                    psycopg2.extras.execute_values(
                        cur,
                        """
                        insert into base_gral_por_compania (compania, parametro, valor)
                        values %s
                        on conflict (compania, parametro)
                        do update set valor = excluded.valor, actualizado_en = now()
                        """,
                        filas_base_compania,
                        page_size=500,
                    )

                    cur.execute("select id, nombre from estudios")
                    mapa_estudio_id = {nombre: id_ for id_, nombre in cur.fetchall()}
                    df_base_est_compania = li.calcular_base_gral_por_estudio_y_compania(df_cartera_completa_bc, {})
                    filas_base_est_compania = [
                        (mapa_estudio_id[r.estudio], r.compania, r.parametro, r.valor)
                        for r in df_base_est_compania.itertuples()
                        if r.estudio in mapa_estudio_id
                    ]
                    if filas_base_est_compania:
                        psycopg2.extras.execute_values(
                            cur,
                            """
                            insert into base_gral_por_estudio_compania (estudio_id, compania, parametro, valor)
                            values %s
                            on conflict (estudio_id, compania, parametro)
                            do update set valor = excluded.valor, actualizado_en = now()
                            """,
                            filas_base_est_compania,
                            page_size=500,
                        )
            finally:
                conn.close()
        except Exception as e:
            _log_carga(usuario, "error", f"Error guardando el backfill: {e}")
            return

        _log_carga(usuario, "ok", f"Backfill de Compania: {len(filas)} causas actualizadas")
    finally:
        try:
            os.remove(ruta)
        except OSError:
            pass


@app.post("/upload-recupero-diario")
async def upload_recupero_diario(
    background_tasks: BackgroundTasks,
    archivo: UploadFile = File(...),
    authorization: str = Header(None),
):
    """Carga LIVIANA de Recupero del día — solo actualiza recupero_diario y
    recupero_diario_detalle (los gráficos de seguimiento diario). NO toca
    Cartera, Pasos Procesales, ni la Matriz mensual (eso sigue haciéndose con
    la carga mensual normal, al cierre del mes)."""
    usuario = verificar_usuario(authorization)
    await archivo.seek(0)
    try:
        ruta = _copiar_a_temp(archivo)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error recibiendo el archivo: {e}")

    _log_carga(usuario, "procesando", "Recupero diario recibido, procesando en segundo plano...")
    background_tasks.add_task(_procesar_recupero_diario, usuario, ruta)
    return {"status": "procesando", "mensaje": "Procesando el Recupero del día..."}


def _procesar_recupero_diario(usuario, ruta):
    try:
        try:
            dict_je, dict_js = _resolver_y_guardar_diccionarios(None, None)

            dict_hojas = lm.leer_tabla_grande(ruta, usecols_necesarias=li.COLUMNAS_RECUPERO_NECESARIAS)
            df = pd.concat(dict_hojas.values(), ignore_index=True)
            for col in ['SubTotEmp', 'Honorarios', 'Aportes']:
                if col in df.columns:
                    df[col] = df[col].apply(lm.limpiar_monto)
            df['Recupero_Total'] = df.get('SubTotEmp', 0) + df.get('Honorarios', 0) + df.get('Aportes', 0)
            col_f_recu = lm.encontrar_columna(df.columns, ['F. Pago', 'Fecha Pago', 'Fecha', 'F.Pago'], palabras_clave_alguna=['fech', 'pago'])
            df['Fecha_Norm'] = pd.to_datetime(df[col_f_recu], errors='coerce', dayfirst=True) if col_f_recu else pd.NaT
            col_juz_recu = 'juzgado' if 'juzgado' in df.columns else 'Juz.' if 'Juz.' in df.columns else None
            df['ESTUDIO_ASIGNADO'] = lm.asignar_estudio_vectorizado(df, 'AboEncarg', col_juz_recu, dict_je, dict_js)
            df['_estudio_norm'] = df['ESTUDIO_ASIGNADO'].astype(str).map(lm.normalizar_texto)

            df_diario = lm.agrupar_recupero_diario(df)
            df_diario_detalle = lm.agrupar_recupero_diario_detalle(df)
        except Exception as e:
            _log_carga(usuario, "error", f"Error procesando el Recupero diario: {e}")
            return

        try:
            conn = obtener_conexion()
            try:
                with conn, conn.cursor() as cur:
                    cur.execute("select id, nombre from estudios")
                    mapa_estudio_id = {nombre: id_ for id_, nombre in cur.fetchall()}

                    filas_diario = [
                        (mapa_estudio_id[r.estudio], r.fecha, r.valor, r.valor_judicial, r.valor_extrajudicial, r.cantidad_fichas,
                         r.valor_cfn, r.cantidad_cfn, r.valor_em, r.cantidad_em, r.valor_confina, r.cantidad_confina)
                        for r in df_diario.itertuples() if r.estudio in mapa_estudio_id
                    ]
                    print(f"[RECUPERO-DIARIO] guardando {len(filas_diario)} filas en recupero_diario...", flush=True)
                    if filas_diario:
                        psycopg2.extras.execute_values(
                            cur,
                            """
                            insert into recupero_diario (estudio_id, fecha, valor, valor_judicial, valor_extrajudicial, cantidad_fichas,
                                                          valor_cfn, cantidad_cfn, valor_em, cantidad_em, valor_confina, cantidad_confina)
                            values %s
                            on conflict (estudio_id, fecha)
                            do update set valor = excluded.valor, valor_judicial = excluded.valor_judicial,
                                valor_extrajudicial = excluded.valor_extrajudicial, cantidad_fichas = excluded.cantidad_fichas,
                                valor_cfn = excluded.valor_cfn, cantidad_cfn = excluded.cantidad_cfn,
                                valor_em = excluded.valor_em, cantidad_em = excluded.cantidad_em,
                                valor_confina = excluded.valor_confina, cantidad_confina = excluded.cantidad_confina,
                                actualizado_en = now()
                            """,
                            filas_diario,
                            page_size=500,
                        )

                    filas_detalle = [
                        (mapa_estudio_id[r.estudio], r.fecha, r.compania, r.tipo, r.valor, r.cantidad_fichas)
                        for r in df_diario_detalle.itertuples() if r.estudio in mapa_estudio_id
                    ]
                    print(f"[RECUPERO-DIARIO] guardando {len(filas_detalle)} filas en recupero_diario_detalle...", flush=True)
                    if filas_detalle:
                        psycopg2.extras.execute_values(
                            cur,
                            """
                            insert into recupero_diario_detalle (estudio_id, fecha, compania, tipo, valor, cantidad_fichas)
                            values %s
                            on conflict (estudio_id, fecha, compania, tipo)
                            do update set valor = excluded.valor, cantidad_fichas = excluded.cantidad_fichas, actualizado_en = now()
                            """,
                            filas_detalle,
                            page_size=500,
                        )
            finally:
                conn.close()
        except Exception as e:
            _log_carga(usuario, "error", f"Error guardando el Recupero diario: {e}")
            return

        _log_carga(usuario, "ok", f"Recupero diario cargado ({len(df_diario)} filas estudio/fecha)")
    finally:
        try:
            os.remove(ruta)
        except OSError:
            pass


@app.post("/upload-pasos-historico")
async def upload_pasos_historico(
    background_tasks: BackgroundTasks,
    mes: str = Form(...),  # 'YYYY-MM-DD', último día del mes
    pasos_mes: UploadFile = File(...),
    authorization: str = Header(None),
):
    """Carga SOLO Pasos Procesales de un mes puntual (para ir completando
    meses anteriores de a uno), sin necesitar altas/bajas/Recupero de ese
    mismo mes. Usa la referencia de Juzgado/Abogados ya guardada."""
    usuario = verificar_usuario(authorization)
    try:
        mes_parseado = datetime.date.fromisoformat(mes)
    except ValueError:
        raise HTTPException(status_code=400, detail="El mes debe venir en formato YYYY-MM-DD")

    await pasos_mes.seek(0)
    try:
        ruta_pasos = _copiar_a_temp(pasos_mes)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error recibiendo el archivo: {e}")

    _log_carga(usuario, "procesando", f"Pasos Procesales histórico de {mes} recibido, procesando en segundo plano...")
    background_tasks.add_task(_procesar_pasos_historico, usuario, mes_parseado, ruta_pasos)
    return {"status": "procesando", "mensaje": "Procesando Pasos Procesales de ese mes en el servidor..."}


def _procesar_pasos_historico(usuario, mes, ruta_pasos):
    try:
        try:
            dict_je, dict_js = _resolver_y_guardar_diccionarios(None, None)
            estudios_validos = _obtener_estudios_validos()
            df_pasos_mes, df_pasos_detalle = li.procesar_pasos_mensual(ruta_pasos, mes, dict_je, dict_js, estudios_validos)
        except Exception as e:
            _log_carga(usuario, "error", f"Error procesando Pasos Procesales: {e}")
            return

        try:
            conn = obtener_conexion()
            try:
                with conn, conn.cursor() as cur:
                    cur.execute("select id, nombre from estudios")
                    mapa_estudio_id = {nombre: id_ for id_, nombre in cur.fetchall()}

                    filas_matriz = [
                        (mapa_estudio_id[r.estudio], r.mes, r.parametro, r.valor)
                        for r in df_pasos_mes.itertuples()
                        if r.estudio in mapa_estudio_id
                    ]
                    if filas_matriz:
                        psycopg2.extras.execute_values(
                            cur,
                            """
                            insert into matriz_mensual (estudio_id, mes, parametro, valor)
                            values %s
                            on conflict (estudio_id, mes, parametro)
                            do update set valor = excluded.valor, actualizado_en = now()
                            """,
                            filas_matriz,
                            page_size=500,
                        )

                    filas_detalle = [
                        (mapa_estudio_id[r.estudio], r.mes, r.compania, r.metrica, r.cantidad_fichas)
                        for r in df_pasos_detalle.itertuples()
                        if r.estudio in mapa_estudio_id
                    ]
                    if filas_detalle:
                        psycopg2.extras.execute_values(
                            cur,
                            """
                            insert into pasos_mensual_detalle (estudio_id, mes, compania, metrica, cantidad_fichas)
                            values %s
                            on conflict (estudio_id, mes, compania, metrica)
                            do update set cantidad_fichas = excluded.cantidad_fichas, actualizado_en = now()
                            """,
                            filas_detalle,
                            page_size=500,
                        )
            finally:
                conn.close()
        except Exception as e:
            _log_carga(usuario, "error", f"Error guardando Pasos Procesales: {e}")
            return

        _log_carga(usuario, "ok", f"Pasos Procesales histórico {mes} cargado")
    finally:
        try:
            os.remove(ruta_pasos)
        except OSError:
            pass


@app.post("/upload-incremental")
async def upload_incremental(
    background_tasks: BackgroundTasks,
    mes: str = Form(...),  # formato 'YYYY-MM-DD', el último día del mes que se está cargando
    altas: UploadFile = File(...),
    bajas: UploadFile = File(...),
    recupero_mes: UploadFile = File(...),
    pasos_mes: UploadFile = File(...),
    juzgados: UploadFile | None = File(None),
    abogados: UploadFile | None = File(None),
    authorization: str = Header(None),
):
    usuario = verificar_usuario(authorization)

    try:
        mes_parseado = datetime.date.fromisoformat(mes)
    except ValueError:
        raise HTTPException(status_code=400, detail="El mes debe venir en formato YYYY-MM-DD")

    archivos_obligatorios = (altas, bajas, recupero_mes, pasos_mes)
    for f in archivos_obligatorios:
        await f.seek(0)
    if juzgados is not None:
        await juzgados.seek(0)
    if abogados is not None:
        await abogados.seek(0)

    try:
        ruta_altas = _copiar_a_temp(altas)
        ruta_bajas = _copiar_a_temp(bajas)
        ruta_recupero_mes = _copiar_a_temp(recupero_mes)
        ruta_pasos_mes = _copiar_a_temp(pasos_mes)
        ruta_juzgados = _copiar_a_temp(juzgados) if juzgados is not None else None
        ruta_abogados = _copiar_a_temp(abogados) if abogados is not None else None
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error recibiendo los archivos: {e}")

    _log_carga(usuario, "procesando", f"Carga incremental del mes {mes} recibida, procesando en segundo plano...")
    background_tasks.add_task(
        _procesar_incremental_en_segundo_plano,
        usuario, mes_parseado, ruta_altas, ruta_bajas, ruta_recupero_mes, ruta_pasos_mes, ruta_juzgados, ruta_abogados,
    )

    return {
        "status": "procesando",
        "mensaje": "Altas/bajas y el mes recibidos correctamente. Se están procesando en el servidor. Revisá el Historial de Cargas para ver cuándo termina.",
    }


def _resolver_y_guardar_diccionarios(ruta_juzgados, ruta_abogados):
    """Si se subieron Juzgado/Abogados este mes: arma los diccionarios, los
    guarda en referencia_juzgado para reusar en meses futuros, y da de alta
    automáticamente cualquier sucursal/estudio nuevo que aparezca en el
    archivo (ej. una que todavía no existe en la tabla estudios).
    Si NO se subieron: reusa lo último guardado."""
    if ruta_juzgados is not None and ruta_abogados is not None:
        print("[INCREMENTAL] Juzgado/Abogados subidos este mes — recalculando y guardando referencia...", flush=True)
        dict_je, dict_js = lm.cargar_diccionarios_juzgado(ruta_juzgados, ruta_abogados)

        df_abogados = pd.read_excel(ruta_abogados)
        nombres_estudio = sorted(set(lm.normalizar_estudio(v) for v in df_abogados['Estudio'].dropna().unique()))

        conn = obtener_conexion()
        try:
            with conn, conn.cursor() as cur:
                cur.execute("select nombre from estudios")
                existentes = {r[0] for r in cur.fetchall()}
                nuevos = [n for n in nombres_estudio if n and n not in existentes]
                if nuevos:
                    print(f"[INCREMENTAL] sucursales nuevas detectadas, dando de alta: {nuevos}", flush=True)
                    psycopg2.extras.execute_values(cur, "insert into estudios (nombre) values %s on conflict (nombre) do nothing", [(n,) for n in nuevos])

                psycopg2.extras.execute_values(
                    cur,
                    """
                    insert into referencia_juzgado (clave, valor) values %s
                    on conflict (clave) do update set valor = excluded.valor, actualizado_en = now()
                    """,
                    [('dict_juzgado_a_estudio', psycopg2.extras.Json(dict_je)), ('dict_juzgado_a_sector', psycopg2.extras.Json(dict_js))],
                )
        finally:
            conn.close()
        return dict_je, dict_js

    print("[INCREMENTAL] Juzgado/Abogados NO subidos este mes — reusando la última referencia guardada...", flush=True)
    conn = obtener_conexion()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("select clave, valor from referencia_juzgado where clave in ('dict_juzgado_a_estudio', 'dict_juzgado_a_sector')")
            filas = dict(cur.fetchall())
    finally:
        conn.close()
    if 'dict_juzgado_a_estudio' not in filas or 'dict_juzgado_a_sector' not in filas:
        raise ValueError("Todavía no hay ninguna referencia de Juzgado/Abogados guardada — subilos al menos una vez.")
    return filas['dict_juzgado_a_estudio'], filas['dict_juzgado_a_sector']


def _obtener_estudios_validos():
    """Lista de nombres de estudio actual, tal como está en la base (incluye
    cualquier sucursal nueva que se haya dado de alta)."""
    conn = obtener_conexion()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("select nombre from estudios order by nombre")
            return [r[0] for r in cur.fetchall()]
    finally:
        conn.close()


def _procesar_incremental_en_segundo_plano(usuario, mes, ruta_altas, ruta_bajas, ruta_recupero_mes, ruta_pasos_mes, ruta_juzgados, ruta_abogados):
    rutas = [r for r in (ruta_altas, ruta_bajas, ruta_recupero_mes, ruta_pasos_mes, ruta_juzgados, ruta_abogados) if r is not None]
    try:
        try:
            dict_je, dict_js = _resolver_y_guardar_diccionarios(ruta_juzgados, ruta_abogados)
            estudios_validos = _obtener_estudios_validos()
            print(f"[INCREMENTAL] {len(estudios_validos)} estudios activos en la base", flush=True)

            print("[INCREMENTAL] procesando altas...", flush=True)
            df_altas = li.procesar_altas(ruta_altas, dict_je, dict_js)
            print(f"[INCREMENTAL] {len(df_altas)} altas procesadas", flush=True)

            print("[INCREMENTAL] procesando bajas...", flush=True)
            fichas_baja = li.procesar_bajas(ruta_bajas)
            print(f"[INCREMENTAL] {len(fichas_baja)} bajas a marcar", flush=True)

            print("[INCREMENTAL] procesando Recupero del mes...", flush=True)
            df_recupero_mes, df_recupero_diario, df_recupero_diario_detalle = li.procesar_recupero_mensual(ruta_recupero_mes, mes, dict_je, dict_js, estudios_validos)

            print("[INCREMENTAL] procesando Pasos Procesales del mes...", flush=True)
            df_pasos_mes, df_pasos_detalle = li.procesar_pasos_mensual(ruta_pasos_mes, mes, dict_je, dict_js, estudios_validos)
        except Exception as e:
            _log_carga(usuario, "error", f"Error procesando los archivos: {e}")
            return

        try:
            _guardar_incremental_en_supabase(mes, df_altas, fichas_baja, df_recupero_mes, df_pasos_mes, estudios_validos, df_recupero_diario, df_recupero_diario_detalle, df_pasos_detalle)
        except Exception as e:
            _log_carga(usuario, "error", f"Error guardando en la base: {e}")
            return

        # Último paso procesal por causa (no bloquea la carga si falla).
        try:
            df_up = li.leer_ultimo_paso_archivo(ruta_pasos_mes)
            conn_up = obtener_conexion()
            try:
                with conn_up, conn_up.cursor() as cur_up:
                    n_up = _actualizar_ultimo_paso(cur_up, df_up)
                print(f"[INCREMENTAL] último paso: {n_up} fichas actualizadas", flush=True)
            finally:
                conn_up.close()
        except Exception as e:
            print(f"[INCREMENTAL] aviso: no se pudo actualizar el último paso: {e}", flush=True)

        _log_carga(usuario, "ok", f"Incremental {mes}: {len(df_altas)} altas, {len(fichas_baja)} bajas")
    finally:
        for ruta in rutas:
            try:
                os.remove(ruta)
            except OSError:
                pass


def _guardar_incremental_en_supabase(mes, df_altas, fichas_baja, df_recupero_mes, df_pasos_mes, estudios_validos, df_recupero_diario, df_recupero_diario_detalle, df_pasos_detalle):
    conn = obtener_conexion()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("select id, nombre from estudios")
            mapa_estudio_id = {nombre: id_ for id_, nombre in cur.fetchall()}

            # --- 1) Upsert de altas en cartera_causas ---
            filas_altas = [
                (
                    r.ficha, mapa_estudio_id.get(r.estudio), r.compania, r.nro_expediente, r.exp_nro_mpr, r.juzgado,
                    r.cod_abo_encargado, r.nivel, r.empresa, r.embargo, r.deuda_total, r.mto_total_pagos,
                    r.fecha_inicio_estudio, r.fecha_ultimo_pago,
                )
                for r in df_altas.itertuples()
            ]
            print(f"[INCREMENTAL-DB] upsert de {len(filas_altas)} altas en cartera_causas...", flush=True)
            if filas_altas:
                psycopg2.extras.execute_values(
                    cur,
                    """
                    insert into cartera_causas
                        (ficha, estudio_id, compania, nro_expediente, exp_nro_mpr, juzgado, cod_abo_encargado,
                         nivel, empresa, embargo, deuda_total, mto_total_pagos, fecha_inicio_estudio, fecha_ultimo_pago)
                    values %s
                    on conflict (ficha) do update set
                        estudio_id = excluded.estudio_id, compania = excluded.compania, nro_expediente = excluded.nro_expediente,
                        exp_nro_mpr = excluded.exp_nro_mpr, juzgado = excluded.juzgado,
                        cod_abo_encargado = excluded.cod_abo_encargado, nivel = excluded.nivel,
                        empresa = excluded.empresa, embargo = excluded.embargo,
                        deuda_total = excluded.deuda_total, mto_total_pagos = excluded.mto_total_pagos,
                        fecha_inicio_estudio = excluded.fecha_inicio_estudio,
                        fecha_ultimo_pago = excluded.fecha_ultimo_pago,
                        activa = true, fecha_baja = null
                    """,
                    filas_altas,
                    page_size=500,
                )

            # --- 2) Marcar bajas ---
            print(f"[INCREMENTAL-DB] marcando {len(fichas_baja)} bajas...", flush=True)
            if fichas_baja:
                cur.execute(
                    "update cartera_causas set activa = false, fecha_baja = now() where ficha = ANY(%s)",
                    (fichas_baja,),
                )

            # --- 3) Traer el estado completo de cartera_causas para recalcular ---
            print("[INCREMENTAL-DB] leyendo cartera_causas completa...", flush=True)
            cur.execute("""
                select cc.ficha, e.nombre as estudio, cc.compania, cc.nro_expediente, cc.juzgado, cc.nivel, cc.empresa,
                       cc.embargo, cc.deuda_total, cc.mto_total_pagos, cc.fecha_inicio_estudio,
                       cc.fecha_ultimo_pago, cc.activa
                from cartera_causas cc
                join estudios e on e.id = cc.estudio_id
            """)
            columnas = ['ficha', 'estudio', 'compania', 'nro_expediente', 'juzgado', 'nivel', 'empresa', 'embargo',
                        'deuda_total', 'mto_total_pagos', 'fecha_inicio_estudio', 'fecha_ultimo_pago', 'activa']
            df_cartera_completa = pd.DataFrame(cur.fetchall(), columns=columnas)
            df_cartera_activa = df_cartera_completa[df_cartera_completa['activa'] == True]  # noqa: E712
            print(f"[INCREMENTAL-DB] {len(df_cartera_completa)} causas en total, {len(df_cartera_activa)} activas", flush=True)

            # --- 4) Guardar el recupero DÍA A DÍA primero (para poder derivar el total del mes sumándolo) ---
            filas_diario = [
                (mapa_estudio_id[r.estudio], r.fecha, r.valor, r.valor_judicial, r.valor_extrajudicial, r.cantidad_fichas, r.valor_cfn, r.cantidad_cfn, r.valor_em, r.cantidad_em, r.valor_confina, r.cantidad_confina)
                for r in df_recupero_diario.itertuples()
                if r.estudio in mapa_estudio_id
            ]
            print(f"[INCREMENTAL-DB] guardando {len(filas_diario)} filas de recupero_diario...", flush=True)
            if filas_diario:
                psycopg2.extras.execute_values(
                    cur,
                    """
                    insert into recupero_diario (estudio_id, fecha, valor, valor_judicial, valor_extrajudicial, cantidad_fichas,
                                                  valor_cfn, cantidad_cfn, valor_em, cantidad_em, valor_confina, cantidad_confina)
                    values %s
                    on conflict (estudio_id, fecha)
                    do update set valor = excluded.valor, valor_judicial = excluded.valor_judicial,
                        valor_extrajudicial = excluded.valor_extrajudicial, cantidad_fichas = excluded.cantidad_fichas,
                        valor_cfn = excluded.valor_cfn, cantidad_cfn = excluded.cantidad_cfn,
                        valor_em = excluded.valor_em, cantidad_em = excluded.cantidad_em,
                        valor_confina = excluded.valor_confina, cantidad_confina = excluded.cantidad_confina,
                        actualizado_en = now()
                    """,
                    filas_diario,
                    page_size=500,
                )

            # --- 5) Derivar el total del MES sumando recupero_diario (así una carga
            # diaria chiquita no "pisa" lo acumulado de días anteriores — funciona
            # tanto si subís el acumulado del mes como si subís solo lo de cada día) ---
            print("[INCREMENTAL-DB] derivando totales del mes desde recupero_diario...", flush=True)
            cur.execute(
                """
                select estudio_id,
                       coalesce(sum(valor), 0) as recupero,
                       coalesce(sum(valor_judicial), 0) as recupero_judicial,
                       coalesce(sum(valor_extrajudicial), 0) as recupero_extra,
                       coalesce(sum(cantidad_fichas), 0) as causas_con_pagos,
                       coalesce(sum(valor_cfn), 0) as recupero_cfn,
                       coalesce(sum(cantidad_cfn), 0) as ccp_cfn,
                       coalesce(sum(valor_em), 0) as recupero_em,
                       coalesce(sum(cantidad_em), 0) as ccp_em,
                       coalesce(sum(valor_confina), 0) as recupero_confina,
                       coalesce(sum(cantidad_confina), 0) as ccp_confina
                from recupero_diario
                where date_trunc('month', fecha) = date_trunc('month', %s::date)
                group by estudio_id
                """,
                (mes,),
            )
            mapa_id_a_estudio = {id_: nombre for nombre, id_ in mapa_estudio_id.items()}
            filas_derivadas = []
            recupero_ultimo_mes = {}
            for (estudio_id, recupero, recupero_jud, recupero_extra, ccp, recupero_cfn, ccp_cfn,
                 recupero_em, ccp_em, recupero_confina, ccp_confina) in cur.fetchall():
                estudio = mapa_id_a_estudio.get(estudio_id)
                if not estudio:
                    continue
                recupero_ultimo_mes[estudio] = float(recupero)
                valores_derivados = {
                    'RECUPERO': recupero, 'RECUPERO JUDICIAL': recupero_jud, 'RECUPERO EXTRA': recupero_extra,
                    'CAUSAS CON PAGOS': ccp,
                    'RECUPERO CFN': recupero_cfn, 'CCP CFN': ccp_cfn,
                    'RECUPERO EM': recupero_em, 'CCP EM': ccp_em,
                    'RECUPERO CONFINA': recupero_confina, 'CCP CONFINA': ccp_confina,
                }
                for parametro, valor in valores_derivados.items():
                    filas_derivadas.append({'estudio': estudio, 'mes': mes, 'parametro': parametro, 'valor': float(valor or 0)})
            df_recupero_derivado = pd.DataFrame(filas_derivadas)

            # Los demás parámetros de Recupero (desgloses jud./ext. por compañía,
            # que todavía no se acumulan día a día) se toman tal cual del archivo
            # de esta carga puntual.
            parametros_derivados = {'RECUPERO', 'RECUPERO JUDICIAL', 'RECUPERO EXTRA', 'CAUSAS CON PAGOS',
                                     'RECUPERO CFN', 'CCP CFN', 'RECUPERO EM', 'CCP EM', 'RECUPERO CONFINA', 'CCP CONFINA'}
            df_recupero_resto = df_recupero_mes[~df_recupero_mes['parametro'].isin(parametros_derivados)]

            df_recibidas_mes = li.calcular_causas_recibidas_mensual(df_cartera_completa, mes, estudios_validos)
            df_matriz_mes = pd.concat([df_recupero_derivado, df_recupero_resto, df_pasos_mes, df_recibidas_mes], ignore_index=True)

            filas_matriz = [
                (mapa_estudio_id[r.estudio], r.mes, r.parametro, r.valor)
                for r in df_matriz_mes.itertuples()
                if r.estudio in mapa_estudio_id
            ]
            print(f"[INCREMENTAL-DB] guardando {len(filas_matriz)} filas del mes {mes} en matriz_mensual...", flush=True)
            psycopg2.extras.execute_values(
                cur,
                """
                insert into matriz_mensual (estudio_id, mes, parametro, valor)
                values %s
                on conflict (estudio_id, mes, parametro)
                do update set valor = excluded.valor, actualizado_en = now()
                """,
                filas_matriz,
                page_size=500,
            )

            # --- 6) Recalcular BASE GRAL (foto actual) a partir de la cartera activa ---
            print("[INCREMENTAL-DB] recalculando base_gral...", flush=True)
            df_base = li.calcular_base_gral_desde_cartera(df_cartera_completa, recupero_ultimo_mes, estudios_validos)
            filas_base = [
                (mapa_estudio_id[r.estudio], r.parametro, r.valor)
                for r in df_base.itertuples()
                if r.estudio in mapa_estudio_id
            ]
            psycopg2.extras.execute_values(
                cur,
                """
                insert into base_gral (estudio_id, parametro, valor)
                values %s
                on conflict (estudio_id, parametro)
                do update set valor = excluded.valor, actualizado_en = now()
                """,
                filas_base,
                page_size=500,
            )

            # --- 6b) Recalcular BASE GRAL POR EMPRESA (nacional, CFN/EM/CONFINA) ---
            print("[INCREMENTAL-DB] recalculando base_gral_por_compania...", flush=True)
            cur.execute(
                """
                select coalesce(sum(valor_cfn), 0), coalesce(sum(valor_em), 0), coalesce(sum(valor_confina), 0)
                from recupero_diario
                where date_trunc('month', fecha) = date_trunc('month', %s::date)
                """,
                (mes,),
            )
            recupero_cfn_nac, recupero_em_nac, recupero_confina_nac = cur.fetchone()
            recupero_ultimo_mes_por_compania = {'CFN': float(recupero_cfn_nac), 'EM': float(recupero_em_nac), 'CONFINA': float(recupero_confina_nac)}
            df_base_compania = li.calcular_base_gral_por_compania(df_cartera_completa, recupero_ultimo_mes_por_compania)
            filas_base_compania = [(r.compania, r.parametro, r.valor) for r in df_base_compania.itertuples()]
            psycopg2.extras.execute_values(
                cur,
                """
                insert into base_gral_por_compania (compania, parametro, valor)
                values %s
                on conflict (compania, parametro)
                do update set valor = excluded.valor, actualizado_en = now()
                """,
                filas_base_compania,
                page_size=500,
            )

            # --- 6c) Recalcular BASE GRAL cruzado ESTUDIO x COMPAÑÍA ---
            print("[INCREMENTAL-DB] recalculando base_gral_por_estudio_compania...", flush=True)
            cur.execute(
                """
                select e.nombre, rdd.compania, coalesce(sum(rdd.valor), 0)
                from recupero_diario_detalle rdd
                join estudios e on e.id = rdd.estudio_id
                where rdd.compania in ('CFN', 'EM', 'CONFINA')
                  and date_trunc('month', rdd.fecha) = date_trunc('month', %s::date)
                group by e.nombre, rdd.compania
                """,
                (mes,),
            )
            recupero_ultimo_mes_por_estudio_compania = {(nombre, compania): float(valor) for nombre, compania, valor in cur.fetchall()}
            df_base_est_compania = li.calcular_base_gral_por_estudio_y_compania(df_cartera_completa, recupero_ultimo_mes_por_estudio_compania, estudios_validos)
            filas_base_est_compania = [
                (mapa_estudio_id[r.estudio], r.compania, r.parametro, r.valor)
                for r in df_base_est_compania.itertuples()
                if r.estudio in mapa_estudio_id
            ]
            if filas_base_est_compania:
                psycopg2.extras.execute_values(
                    cur,
                    """
                    insert into base_gral_por_estudio_compania (estudio_id, compania, parametro, valor)
                    values %s
                    on conflict (estudio_id, compania, parametro)
                    do update set valor = excluded.valor, actualizado_en = now()
                    """,
                    filas_base_est_compania,
                    page_size=500,
                )

            filas_detalle = [
                (mapa_estudio_id[r.estudio], r.fecha, r.compania, r.tipo, r.valor, r.cantidad_fichas)
                for r in df_recupero_diario_detalle.itertuples()
                if r.estudio in mapa_estudio_id
            ]
            print(f"[INCREMENTAL-DB] guardando {len(filas_detalle)} filas de recupero_diario_detalle...", flush=True)
            if filas_detalle:
                psycopg2.extras.execute_values(
                    cur,
                    """
                    insert into recupero_diario_detalle (estudio_id, fecha, compania, tipo, valor, cantidad_fichas)
                    values %s
                    on conflict (estudio_id, fecha, compania, tipo)
                    do update set valor = excluded.valor, cantidad_fichas = excluded.cantidad_fichas, actualizado_en = now()
                    """,
                    filas_detalle,
                    page_size=500,
                )
            filas_pasos_detalle = [
                (mapa_estudio_id[r.estudio], r.mes, r.compania, r.metrica, r.cantidad_fichas)
                for r in df_pasos_detalle.itertuples()
                if r.estudio in mapa_estudio_id
            ]
            print(f"[INCREMENTAL-DB] guardando {len(filas_pasos_detalle)} filas de pasos_mensual_detalle...", flush=True)
            if filas_pasos_detalle:
                psycopg2.extras.execute_values(
                    cur,
                    """
                    insert into pasos_mensual_detalle (estudio_id, mes, compania, metrica, cantidad_fichas)
                    values %s
                    on conflict (estudio_id, mes, compania, metrica)
                    do update set cantidad_fichas = excluded.cantidad_fichas, actualizado_en = now()
                    """,
                    filas_pasos_detalle,
                    page_size=500,
                )
            print("[INCREMENTAL-DB] listo", flush=True)
    finally:
        conn.close()
