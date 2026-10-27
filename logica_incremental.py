"""
Lógica de la carga INCREMENTAL (altas/bajas mensuales), como alternativa a la
carga completa (analizadormatriz / logica_matriz.ProcesadorMatriz).

Reutiliza las mismas constantes y funciones de asignación de estudio ya
validadas en logica_matriz.py — NO se duplica esa lógica, solo se reutiliza
con un flujo de datos distinto (deltas mensuales en vez de archivos completos).
"""
import pandas as pd

from logica_matriz import (
    log_memoria, leer_tabla_grande, encontrar_columna, normalizar_texto, limpiar_monto, quitar_tildes,
    cargar_diccionarios_juzgado, asignar_estudio_vectorizado, agrupar_recupero_diario,
    agrupar_recupero_diario_detalle, calcular_mascaras_pasos, contar_fichas, agrupar_pasos_detalle,
    ESTUDIOS_VALIDOS, EXCLUSIONES_DOMICILIO, EXCLUSIONES_LABORAL,
    NIVELES_ST_SP, NIVELES_CONTRAPARTE,
)

COLUMNAS_CARTERA_NECESARIAS = {
    'Ficha', 'Compania', 'Nro Expediente', 'Exp Nro Mpr', 'Juzgado', 'Cod Abo Encargado',
    'Nivel', 'Empresa', 'Embargo', 'Deuda Total', 'Mto Total Pagos',
    'Fecha Inicio Estudio', 'F_Inicio', 'Fecha Ultimo Pago',
}
COLUMNAS_RECUPERO_NECESARIAS = {
    'F. Pago', 'Fecha Pago', 'Fecha', 'F.Pago',
    'AboEncarg', 'juzgado', 'Juz.', 'Embargo', 'Compania',
    'SubTotEmp', 'Honorarios', 'Aportes',
}


def normalizar_compania(valor):
    """'CFN S.R.L.' -> 'CFN', 'Electrónica Megatone S.R.L.' -> 'EM', etc."""
    v = quitar_tildes(str(valor)).upper()
    if 'CFN' in v:
        return 'CFN'
    if 'MEGATONE' in v:
        return 'EM'
    if 'CONFINA' in v:
        return 'CONFINA'
    return 'OTRA'


def procesar_altas(archivo_altas, dict_juzgado_a_estudio, dict_juzgado_a_sector):
    """Lee el archivo de altas del mes y devuelve un DataFrame con una fila por
    causa, listo para hacer upsert en la tabla cartera_causas."""
    dict_hojas = leer_tabla_grande(
        archivo_altas, usecols_necesarias=COLUMNAS_CARTERA_NECESARIAS,
        dtype={'Ficha': str, 'Nro Expediente': str, 'Juzgado': str},
    )
    df = pd.concat(dict_hojas.values(), ignore_index=True)
    if 'Ficha' not in df.columns:
        raise ValueError("El archivo de altas no tiene columna 'Ficha' — es el identificador obligatorio.")

    df['ESTUDIO_ASIGNADO'] = asignar_estudio_vectorizado(
        df, 'Cod Abo Encargado', 'Juzgado', dict_juzgado_a_estudio, dict_juzgado_a_sector
    )

    col_f_inicio = 'Fecha Inicio Estudio' if 'Fecha Inicio Estudio' in df.columns else 'F_Inicio'
    fecha_inicio = pd.to_datetime(df[col_f_inicio], errors='coerce', dayfirst=True) if col_f_inicio in df.columns else pd.Series([pd.NaT] * len(df))
    fecha_ultimo_pago = pd.to_datetime(df['Fecha Ultimo Pago'], errors='coerce', dayfirst=True) if 'Fecha Ultimo Pago' in df.columns else pd.Series([pd.NaT] * len(df))

    def a_fecha_o_none(serie_fecha):
        # psycopg2 no sabe convertir NaT de pandas — hay que pasar None a mano.
        return [None if pd.isna(v) else v.date() for v in serie_fecha]

    resultado = pd.DataFrame({
        'ficha': df['Ficha'].astype(str).str.strip(),
        'estudio': df['ESTUDIO_ASIGNADO'].astype(str),
        'compania': df.get('Compania', '').apply(normalizar_compania) if 'Compania' in df.columns else 'OTRA',
        'nro_expediente': df.get('Nro Expediente', '').astype(str),
        'exp_nro_mpr': df.get('Exp Nro Mpr', '').astype(str),
        'juzgado': df.get('Juzgado', '').astype(str),
        'cod_abo_encargado': df.get('Cod Abo Encargado', '').astype(str),
        'nivel': df.get('Nivel', '').astype(str),
        'empresa': df.get('Empresa', '').astype(str),
        'embargo': df.get('Embargo', '').astype(str),
        'deuda_total': df.get('Deuda Total', 0).apply(limpiar_monto) if 'Deuda Total' in df.columns else 0.0,
        'mto_total_pagos': df.get('Mto Total Pagos', 0).apply(limpiar_monto) if 'Mto Total Pagos' in df.columns else 0.0,
        'fecha_inicio_estudio': a_fecha_o_none(fecha_inicio),
        'fecha_ultimo_pago': a_fecha_o_none(fecha_ultimo_pago),
    })
    resultado = resultado[resultado['ficha'] != '']
    resultado = resultado[resultado['ficha'].str.lower() != 'nan']
    return resultado.drop_duplicates(subset='ficha', keep='last')


def procesar_cancelados_archivo(archivo, dict_juzgado_a_estudio, dict_juzgado_a_sector):
    """Lee un archivo de juicios CANCELADOS (mismo formato que Cartera, columna
    Cancelada = S) y devuelve un DataFrame listo para cartera_causas, con:
      - 'fecha_baja': la Fecha Ultimo Pago del archivo (fecha de cancelación),
      - el estudio asignado con la misma regla de la Matriz (código del abogado
        y, si no alcanza, juzgado).
    El archivo de cancelados NO trae 'Cod Abo Encargado': se usa
    'Cod Abo Responsable'."""
    dict_hojas = leer_tabla_grande(
        archivo, dtype={'Ficha': str, 'Nro Expediente': str, 'Juzgado': str},
    )
    df = pd.concat(dict_hojas.values(), ignore_index=True)
    if 'Ficha' not in df.columns:
        raise ValueError("El archivo de cancelados no tiene columna 'Ficha'.")
    # El equivalente de 'Cod Abo Encargado' en el archivo de cancelados es
    # 'Cod Abo Responsable' (criterio indicado por el usuario).
    if 'Cod Abo Encargado' not in df.columns:
        for alt in ('Cod Abo Responsable',):
            if alt in df.columns:
                df['Cod Abo Encargado'] = df[alt]
                break
    df['ESTUDIO_ASIGNADO'] = asignar_estudio_vectorizado(
        df, 'Cod Abo Encargado', 'Juzgado', dict_juzgado_a_estudio, dict_juzgado_a_sector
    )

    def a_fecha(col):
        if col not in df.columns:
            return [None] * len(df)
        s = pd.to_datetime(df[col], errors='coerce', dayfirst=True)
        return [None if pd.isna(v) else v.date() for v in s]

    def texto(col):
        return df[col].fillna('').astype(str).str.strip() if col in df.columns else pd.Series([''] * len(df), index=df.index)

    capital = df['Capital Original'].apply(limpiar_monto) if 'Capital Original' in df.columns else 0.0
    resultado = pd.DataFrame({
        'ficha': df['Ficha'].astype(str).str.strip(),
        'estudio': df['ESTUDIO_ASIGNADO'].astype(str),
        'compania': df['Compania'].apply(normalizar_compania) if 'Compania' in df.columns else 'OTRA',
        'nro_expediente': texto('Nro Expediente'),
        'exp_nro_mpr': texto('Exp Nro Mpr'),
        'juzgado': texto('Juzgado'),
        'cod_abo_encargado': texto('Cod Abo Encargado'),
        'nivel': texto('Nivel'),
        'empresa': texto('Empresa'),
        'embargo': texto('Embargo'),
        'deuda_total': capital,
        'mto_total_pagos': 0.0,
        'fecha_inicio_estudio': a_fecha('Fecha Inicio Estudio'),
        'fecha_ultimo_pago': a_fecha('Fecha Ultimo Pago'),
        # Fechas imposibles (futuras, p. ej. un año mal tipeado) se descartan: la baja se registra con la fecha de la carga.
        'fecha_baja': [None if (f is not None and f > __import__('datetime').date.today()) else f for f in a_fecha('Fecha Ultimo Pago')],
    })
    resultado = resultado[resultado['ficha'] != '']
    resultado = resultado[resultado['ficha'].str.lower() != 'nan']
    return resultado.drop_duplicates(subset='ficha', keep='last')


def procesar_bajas(archivo_bajas):
    """Lee el archivo de bajas del mes (ej. bajasmes.xlsx) y devuelve la lista
    de números de Ficha a marcar como inactivos."""
    dict_hojas = leer_tabla_grande(archivo_bajas, dtype={'Ficha': str})
    df = pd.concat(dict_hojas.values(), ignore_index=True)
    col_ficha = encontrar_columna(df.columns, ['Ficha'], palabras_clave_alguna=['ficha'])
    if not col_ficha:
        raise ValueError("El archivo de bajas no tiene ninguna columna reconocible como 'Ficha'.")
    fichas = df[col_ficha].astype(str).str.strip()
    return sorted(set(f for f in fichas.tolist() if f and f.lower() != 'nan'))


def procesar_recupero_mensual(archivo_recupero_mes, mes, dict_juzgado_a_estudio, dict_juzgado_a_sector, estudios_validos=None):
    """Lee UNA hoja/archivo de Recupero (un solo mes) y devuelve:
    - un DataFrame con las filas de matriz_mensual para ese mes (25+ estudios)
    - un DataFrame con el recupero DÍA A DÍA (estudio, fecha, valor), para el
      seguimiento diario/semanal — se arma con la misma fecha de pago
      ("F. Pago") que ya trae el archivo, sin pedir nada nuevo."""
    estudios_validos = estudios_validos or ESTUDIOS_VALIDOS
    dict_hojas = leer_tabla_grande(archivo_recupero_mes, usecols_necesarias=COLUMNAS_RECUPERO_NECESARIAS)
    df = pd.concat(dict_hojas.values(), ignore_index=True)

    for col in ['SubTotEmp', 'Honorarios', 'Aportes']:
        if col in df.columns:
            df[col] = df[col].apply(limpiar_monto)
    df['Recupero_Total'] = df.get('SubTotEmp', 0) + df.get('Honorarios', 0) + df.get('Aportes', 0)

    col_f_recu = encontrar_columna(df.columns, ['F. Pago', 'Fecha Pago', 'Fecha', 'F.Pago'], palabras_clave_alguna=['fech', 'pago'])
    df['Fecha_Norm'] = pd.to_datetime(df[col_f_recu], errors='coerce', dayfirst=True) if col_f_recu else pd.NaT

    col_juz_recu = 'juzgado' if 'juzgado' in df.columns else 'Juz.' if 'Juz.' in df.columns else None
    df['ESTUDIO_ASIGNADO'] = asignar_estudio_vectorizado(
        df, 'AboEncarg', col_juz_recu, dict_juzgado_a_estudio, dict_juzgado_a_sector
    )
    df['_estudio_norm'] = df['ESTUDIO_ASIGNADO'].astype(str).map(normalizar_texto)

    # --- Recupero día a día (para el seguimiento diario/semanal) ---
    diario = agrupar_recupero_diario(df)
    diario_detalle = agrupar_recupero_diario_detalle(df)

    filas = []
    for estudio in estudios_validos:
        recu = df[df['_estudio_norm'] == estudio]
        embargo_col = recu.get('Embargo', pd.Series(dtype=str)).astype(str).str.upper()
        recu_jud = recu[embargo_col == 'S']
        recu_extra = recu[embargo_col == 'N']
        recu_cfn = recu[recu.get('Compania', '').astype(str).str.upper().str.contains('CFN', na=False)]
        recu_em = recu[recu.get('Compania', '').astype(str).str.upper().str.contains('MEGATONE', na=False)]
        recu_confina = recu[recu.get('Compania', '').astype(str).str.upper().str.contains('CONFINA', na=False)]

        def desglose(sub):
            emb = sub.get('Embargo', pd.Series(dtype=str)).astype(str).str.upper()
            return sub['Recupero_Total'].sum(), sub[emb == 'S']['Recupero_Total'].sum(), sub[emb == 'N']['Recupero_Total'].sum(), sub.shape[0], sub[emb == 'S'].shape[0], sub[emb == 'N'].shape[0]

        cfn_tot, cfn_jud, cfn_ext, cfn_n, cfn_njud, cfn_next = desglose(recu_cfn)
        em_tot, em_jud, em_ext, em_n, em_njud, em_next = desglose(recu_em)
        conf_tot, conf_jud, conf_ext, conf_n, conf_njud, conf_next = desglose(recu_confina)

        valores = {
            'RECUPERO': recu['Recupero_Total'].sum(),
            'RECUPERO JUDICIAL': recu_jud['Recupero_Total'].sum(),
            'RECUPERO EXTRA': recu_extra['Recupero_Total'].sum(),
            'CAUSAS CON PAGOS': recu.shape[0],
            'CAUSAS CON PAGOS JUD.': recu_jud.shape[0],
            'CAUSAS CON PAGOS EXT.': recu_extra.shape[0],
            'RECUPERO CFN': cfn_tot, 'RECUPERO CFN JUD.': cfn_jud, 'RECUPERO CFN EXT.': cfn_ext,
            'CCP CFN': cfn_n, 'CCP CFN JUD.': cfn_njud, 'CCP CFN EXT.': cfn_next,
            'RECUPERO EM': em_tot, 'RECUPERO EM JUD.': em_jud, 'RECUPERO EM EXT.': em_ext,
            'CCP EM': em_n, 'CCP EM JUD.': em_njud, 'CCP EM EXT.': em_next,
            'RECUPERO CONFINA': conf_tot, 'RECUPERO CONFINA JUD.': conf_jud, 'RECUPERO CONFINA EXT.': conf_ext,
            'CCP CONFINA': conf_n, 'CCP CONFINA JUD.': conf_njud, 'CCP CONFINA EXT.': conf_next,
        }
        for parametro, valor in valores.items():
            filas.append({'estudio': estudio, 'mes': mes, 'parametro': parametro, 'valor': float(valor or 0)})
    return pd.DataFrame(filas), diario, diario_detalle


def procesar_pasos_mensual(archivo_pasos_mes, mes, dict_juzgado_a_estudio, dict_juzgado_a_sector, estudios_validos=None):
    estudios_validos = estudios_validos or ESTUDIOS_VALIDOS
    """Lee los pasos procesales del mes y devuelve (df_matriz_mes, df_detalle):
    - df_matriz_mes: sentencias/liquidaciones/embargos del mes, para los estudios
    - df_detalle: lo mismo pero desglosado por compañía (TOTAL/CFN/EM/CONFINA)"""
    df = pd.read_excel(archivo_pasos_mes)

    col_abo_pasos = encontrar_columna(df.columns, ['Cod Abo Encargado', 'Cod Abo Responsable', 'Codigo Abogado'], palabras_clave_todas=[['cod', 'abo']])
    col_juz_pasos = 'Juzgado' if 'Juzgado' in df.columns else 'Juz'
    col_paso = 'Paso Procesal' if 'Paso Procesal' in df.columns else 'Estado'

    df['ESTUDIO_ASIGNADO'] = asignar_estudio_vectorizado(
        df, col_abo_pasos, col_juz_pasos, dict_juzgado_a_estudio, dict_juzgado_a_sector
    )
    df['_estudio_norm'] = df['ESTUDIO_ASIGNADO'].astype(str).map(normalizar_texto)
    df['Paso_Limpio'] = df.get(col_paso, '').astype(str).str.lower()

    filas = []
    for estudio in estudios_validos:
        paso = df[df['_estudio_norm'] == estudio]
        es_sentencia, es_liquidacion, es_embargo = calcular_mascaras_pasos(paso)
        valores = {
            'CANT. DE SENTENCIAS FIRMES': contar_fichas(paso, es_sentencia),
            'CANT. DE LIQUIDACIONES': contar_fichas(paso, es_liquidacion),
            'NUEVOS EMBARGOS': contar_fichas(paso, es_embargo),
        }
        for parametro, valor in valores.items():
            filas.append({'estudio': estudio, 'mes': mes, 'parametro': parametro, 'valor': float(valor or 0)})

    df_detalle = agrupar_pasos_detalle(df, mes)
    return pd.DataFrame(filas), df_detalle


def leer_ultimo_paso_archivo(archivo_pasos):
    """Lee un archivo de Pasos Procesales (el mismo que se usa en la carga mensual)
    y devuelve, por ficha, su paso más reciente: DataFrame con
    ficha, fecha_ultimo_paso (date) y ultimo_paso (texto).
    Si una ficha tiene varios pasos, se queda con el de fecha más nueva (y,
    a igual fecha, el último que figura en el archivo)."""
    df = pd.read_excel(archivo_pasos)
    col_ficha = 'Ficha' if 'Ficha' in df.columns else encontrar_columna(df.columns, ['Ficha'], palabras_clave_alguna=['ficha'])
    col_paso = 'Paso Procesal' if 'Paso Procesal' in df.columns else None
    col_f = encontrar_columna(df.columns, ['Fecha Paso Procesal', 'F. PProcesal', 'F.PProcesal'],
                              palabras_clave_todas=[['fech', 'paso']], palabras_clave_alguna=['fech'])
    if not col_ficha or not col_f:
        raise ValueError("El archivo de pasos no trae las columnas 'Ficha' y 'Fecha Paso Procesal'")
    fechas = df[col_f]
    if not pd.api.types.is_datetime64_any_dtype(fechas):
        fechas = pd.to_datetime(fechas, errors='coerce', dayfirst=True)
    out = pd.DataFrame({
        'ficha': df[col_ficha].astype(str).str.strip(),
        'fecha_ultimo_paso': fechas,
        'ultimo_paso': df[col_paso].astype(str).str.strip() if col_paso else '',
    })
    out = out[(out['ficha'] != '') & (out['ficha'].str.lower() != 'nan') & out['fecha_ultimo_paso'].notna()].copy()
    out['_orden'] = range(len(out))
    out = out.sort_values(['ficha', 'fecha_ultimo_paso', '_orden']).groupby('ficha', as_index=False).tail(1)
    out['fecha_ultimo_paso'] = out['fecha_ultimo_paso'].dt.date
    return out[['ficha', 'fecha_ultimo_paso', 'ultimo_paso']].reset_index(drop=True)


def calcular_causas_recibidas_mensual(df_cartera_activa_e_inactiva, mes, estudios_validos=None):
    estudios_validos = estudios_validos or ESTUDIOS_VALIDOS
    """CAUSAS RECIBIDAS / SIN INICIAR del mes, a partir de fecha_inicio_estudio
    de TODAS las causas (activas e inactivas — una causa cuenta como "recibida"
    el mes que entró, aunque después se haya dado de baja)."""
    df = df_cartera_activa_e_inactiva
    fecha_inicio = pd.to_datetime(df['fecha_inicio_estudio'], errors='coerce')
    del_mes = df[(fecha_inicio.dt.year == mes.year) & (fecha_inicio.dt.month == mes.month)]

    filas = []
    for estudio in estudios_validos:
        sub = del_mes[del_mes['estudio'].astype(str).map(normalizar_texto) == estudio]
        tiene_exp = (sub['nro_expediente'].astype(str).str.strip() != '') & (sub['juzgado'].astype(str).str.strip() != '') & (sub['juzgado'].astype(str).str.strip() != '0-JUZGADO')
        filas.append({'estudio': estudio, 'mes': mes, 'parametro': 'CAUSAS RECIBIDAS', 'valor': float(sub.shape[0])})
        filas.append({'estudio': estudio, 'mes': mes, 'parametro': 'CAUSAS RECIBIDAS SIN INICIAR', 'valor': float((~tiene_exp).sum())})
    return pd.DataFrame(filas)


def _resumen_metricas_cartera(cart_completo):
    """Calcula el diccionario de métricas de gestión (En Gestión, Iniciadas,
    Con Embargo, etc.) para un subconjunto de cartera_causas ya filtrado
    (por estudio, por compañía, o lo que sea). Reutilizado por
    calcular_base_gral_desde_cartera y calcular_base_gral_por_compania.

    cart_completo debe traer TODAS las causas del subconjunto — activas e
    inactivas (dadas de baja/canceladas) — con una columna 'activa'. La
    mayoría de las métricas (En Gestión, Iniciadas, etc.) se calculan solo
    sobre las activas, como siempre; CANCELADAS e INICIADAS TOTALES usan el
    conjunto completo a propósito."""
    import datetime
    tiene_columna_activa = 'activa' in cart_completo.columns
    cart = cart_completo[cart_completo['activa'] == True] if tiene_columna_activa else cart_completo  # noqa: E712

    mask_tiene_exp_juz = (cart['nro_expediente'] != '') & (cart['juzgado'] != '') & (cart['juzgado'] != '0-JUZGADO')
    mask_es_laboral = (cart['empresa'] != '') & (~cart['empresa'].str.lower().str.contains('|'.join(EXCLUSIONES_LABORAL), na=False))
    mask_excluye_domicilio = cart['nivel'].str.lower().str.contains('|'.join(EXCLUSIONES_DOMICILIO), na=False)
    mask_es_embargo_s = cart['embargo'].str.upper() == 'S'
    mask_inhibicion = cart['nivel'].str.lower().str.contains('inhibici', na=False)
    mask_con_pagos = cart.get('mto_total_pagos', 0).astype(float) > 0

    iniciadas = cart[mask_tiene_exp_juz].shape[0]
    en_gestion = cart.shape[0]
    en_gestion_lab = cart[mask_es_laboral].shape[0]
    en_gestion_dom = cart[~mask_excluye_domicilio].shape[0]
    con_inhibicion = cart[mask_inhibicion].shape[0]
    a_recuperar = cart.get('deuda_total', 0).sum()
    proc_inicio_lab = cart[~mask_tiene_exp_juz & mask_es_laboral].shape[0]
    proc_inicio_sin_lab = cart[~mask_tiene_exp_juz & ~mask_es_laboral].shape[0]
    embargo_haberes = cart[mask_es_embargo_s & ~mask_inhibicion].shape[0]
    con_pagos_snapshot = cart[mask_con_pagos].shape[0]

    sin_pago_5 = 0
    if 'fecha_ultimo_pago' in cart.columns:
        fecha_pago = pd.to_datetime(cart['fecha_ultimo_pago'], errors='coerce')
        hoy = pd.Timestamp(datetime.date.today())
        sin_pago_5 = (fecha_pago < (hoy - pd.DateOffset(years=5))).sum()

    st_sp = cart[cart['nivel'].str.lower().str.contains('|'.join(NIVELES_ST_SP), na=False)].shape[0]
    contraparte = cart[cart['nivel'].str.lower().str.contains('|'.join(NIVELES_CONTRAPARTE), na=False)].shape[0]

    # Canceladas: cuenta sobre TODO el conjunto (activas + inactivas), no
    # solo las activas — si no viene la columna 'activa', no hay forma de
    # saber cuáles son canceladas, así que queda en 0.
    canceladas = cart_completo[cart_completo['activa'] == False].shape[0] if tiene_columna_activa else 0  # noqa: E712

    # Iniciadas Totales: causas que alguna vez llegaron a tener expediente y
    # juzgado, estén o no activas hoy (a diferencia de INICIADAS, que solo
    # cuenta las que siguen en gestión activa).
    mask_tiene_exp_juz_completo = (
        (cart_completo['nro_expediente'] != '') & (cart_completo['juzgado'] != '') & (cart_completo['juzgado'] != '0-JUZGADO')
    )
    iniciadas_totales = cart_completo[mask_tiene_exp_juz_completo].shape[0]

    # Canceladas sin iniciar: canceladas que nunca tuvieron expediente/juzgado
    # (no suman en INICIADAS TOTALES). Cierra la cuenta:
    # INICIADAS TOTALES - (CANCELADAS - CANCELADAS SIN INICIAR) = INICIADAS.
    canceladas_sin_iniciar = (
        cart_completo[(cart_completo['activa'] == False) & ~mask_tiene_exp_juz_completo].shape[0]  # noqa: E712
        if tiene_columna_activa else 0
    )

    return {
        'INICIADAS': iniciadas, 'INICIADAS TOTALES': iniciadas_totales, 'CANCELADAS': canceladas, 'CANCELADAS SIN INICIAR': canceladas_sin_iniciar,
        'EN GESTIÓN': en_gestion,
        'EN GESTION CON LABORAL': en_gestion_lab, 'EN GESTION CON DOMICILIO': en_gestion_dom,
        'CON IINHIBICION ': con_inhibicion, '$$ A RECUPERAR GRAL': a_recuperar,
        'PROCESO DE INICIO CON LABORAL': proc_inicio_lab, 'PROCESO DE INICIO SIN LABORAL': proc_inicio_sin_lab,
        'PROCESO DE INICIO CON DOM.': 0, 'PROCESO DE INICIO SIN DOM.': 0,
        'CON EMBARGO HABERES': embargo_haberes, 'CON PAGOS': con_pagos_snapshot,
        '5 AÑOS SIN PAGOS': float(sin_pago_5), 'ST/SP': st_sp, 'CONTRAPARTE': contraparte,
    }


def calcular_base_gral_desde_cartera(df_cartera_completa, recupero_ultimo_mes_por_estudio, estudios_validos=None):
    """Recalcula la hoja BASE GRAL POR ESTUDIO (foto actual) a partir del estado
    persistido de cartera_causas. df_cartera_completa debe traer activas E
    inactivas (con columna 'activa') — así se puede calcular CANCELADAS e
    INICIADAS TOTALES además de las métricas de siempre (que igual solo
    cuentan las activas, como corresponde)."""
    estudios_validos = estudios_validos or ESTUDIOS_VALIDOS
    df = df_cartera_completa.copy()
    for col in ['nivel', 'empresa', 'embargo', 'juzgado', 'nro_expediente']:
        if col not in df.columns:
            df[col] = ''
        df[col] = df[col].astype(str)

    filas = []
    for estudio in estudios_validos:
        cart = df[df['estudio'].astype(str).map(normalizar_texto) == estudio]
        resumen = {'RECUPERO ULT.MES CERRADO': recupero_ultimo_mes_por_estudio.get(estudio, 0)}
        resumen.update(_resumen_metricas_cartera(cart))
        for parametro, valor in resumen.items():
            filas.append({'estudio': estudio, 'parametro': parametro, 'valor': float(valor or 0)})
    return pd.DataFrame(filas)


def calcular_base_gral_por_compania(df_cartera_completa, recupero_ultimo_mes_por_compania):
    """Igual que calcular_base_gral_desde_cartera, pero agrupado por
    COMPAÑÍA (CFN/EM/CONFINA) en vez de por estudio — a nivel nacional,
    sumando todos los estudios, para la pestaña 'Por Empresa'."""
    df = df_cartera_completa.copy()
    for col in ['nivel', 'empresa', 'embargo', 'juzgado', 'nro_expediente', 'compania']:
        if col not in df.columns:
            df[col] = ''
        df[col] = df[col].astype(str)

    filas = []
    for compania in ['CFN', 'EM', 'CONFINA']:
        cart = df[df['compania'].str.upper() == compania]
        resumen = {'RECUPERO ULT.MES CERRADO': recupero_ultimo_mes_por_compania.get(compania, 0)}
        resumen.update(_resumen_metricas_cartera(cart))
        for parametro, valor in resumen.items():
            filas.append({'compania': compania, 'parametro': parametro, 'valor': float(valor or 0)})
    return pd.DataFrame(filas)


def calcular_base_gral_por_estudio_y_compania(df_cartera_completa, recupero_ultimo_mes_por_estudio_compania, estudios_validos=None):
    """Cruce estudio x compañía — para el desplegable de compañía dentro de
    'Detalle por estudio'. recupero_ultimo_mes_por_estudio_compania es un dict
    {(estudio, compania): valor}."""
    estudios_validos = estudios_validos or ESTUDIOS_VALIDOS
    df = df_cartera_completa.copy()
    for col in ['nivel', 'empresa', 'embargo', 'juzgado', 'nro_expediente', 'compania']:
        if col not in df.columns:
            df[col] = ''
        df[col] = df[col].astype(str)
    df['_estudio_norm'] = df['estudio'].astype(str).map(normalizar_texto)

    filas = []
    for estudio in estudios_validos:
        cart_estudio = df[df['_estudio_norm'] == estudio]
        if cart_estudio.empty:
            continue
        for compania in ['CFN', 'EM', 'CONFINA']:
            cart = cart_estudio[cart_estudio['compania'].str.upper() == compania]
            resumen = {'RECUPERO ULT.MES CERRADO': recupero_ultimo_mes_por_estudio_compania.get((estudio, compania), 0)}
            resumen.update(_resumen_metricas_cartera(cart))
            for parametro, valor in resumen.items():
                filas.append({'estudio': estudio, 'compania': compania, 'parametro': parametro, 'valor': float(valor or 0)})
    return pd.DataFrame(filas)
