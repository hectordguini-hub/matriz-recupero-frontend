const supabaseClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// Supabase tiene un límite máximo de filas por consulta configurado a nivel
// de proyecto (normalmente 1000) que .limit() del lado del cliente NO puede
// pisar. Para traer TODO sin importar cuántas filas haya, pedimos "de a
// páginas" con .range() hasta que la página vuelva incompleta.
async function consultarPaginado(construirConsulta, tamanioPagina = 1000) {
  let todas = [];
  let desde = 0;
  while (true) {
    const { data, error } = await construirConsulta().range(desde, desde + tamanioPagina - 1);
    if (error) { console.error(error); break; }
    if (!data || data.length === 0) break;
    todas = todas.concat(data);
    if (data.length < tamanioPagina) break;
    desde += tamanioPagina;
  }
  return todas;
}

const COLOR_TINTA = '#25404a';
const COLOR_BRONCE = '#ca0130';
const COLOR_VERDE = '#3f6b4f';
const COLOR_ROJO = '#a23b2d';
const COLOR_LINEA = '#dedad0';
const COLOR_JUDICIAL = '#25404a';       // navy — bien distinto del extrajudicial
const COLOR_EXTRAJUDICIAL = '#c9820a';  // ámbar — bien distinto del judicial y del verde
const COLOR_CFN = '#ca0130';       // bronce/rojo
const COLOR_EM = '#25404a';        // navy
const COLOR_CONFINA = '#3f6b4f';   // verde

const formateadorMoneda = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const formateadorNumero = new Intl.NumberFormat('es-AR');

let graficos = {}; // referencias a instancias de Chart.js, para poder destruir/redibujar

// ============================================================
// AUTENTICACIÓN
// ============================================================
async function iniciarApp() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    mostrarApp(session);
  } else {
    document.getElementById('pantalla-login').classList.remove('oculto');
  }
}

document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    errorEl.textContent = 'Email o contraseña incorrectos.';
    return;
  }
  mostrarApp(data.session);
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await supabaseClient.auth.signOut();
  window.location.reload();
});

function mostrarApp(session) {
  document.getElementById('pantalla-login').classList.add('oculto');

  // Si el usuario fue creado con la marca "debe cambiar la contraseña" (se
  // pone al crearlo en Supabase, en el campo de metadata del usuario), no lo
  // dejamos entrar al dashboard hasta que la cambie.
  if (session.user.user_metadata && session.user.user_metadata.must_change_password) {
    document.getElementById('pantalla-cambiar-password').classList.remove('oculto');
    return;
  }

  document.getElementById('app').classList.remove('oculto');
  document.getElementById('usuario-email').textContent = session.user.email;
  cargarVistaResumen();
  cargarSelectorEstudios();
  cargarVistaEmpresa('CFN');
  cargarLogCargas();
}

document.getElementById('form-cambiar-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('cambiar-password-error');
  errorEl.textContent = '';
  const nueva = document.getElementById('nueva-password').value;
  const confirmar = document.getElementById('nueva-password-confirmar').value;

  if (nueva !== confirmar) {
    errorEl.textContent = 'Las dos contraseñas no coinciden.';
    return;
  }

  const { data, error } = await supabaseClient.auth.updateUser({
    password: nueva,
    data: { must_change_password: false },
  });
  if (error) {
    errorEl.textContent = 'No se pudo guardar la contraseña: ' + error.message;
    return;
  }

  document.getElementById('pantalla-cambiar-password').classList.add('oculto');
  mostrarApp(data.user ? { user: data.user } : (await supabaseClient.auth.getSession()).data.session);
});

// ============================================================
// NAVEGACIÓN ENTRE PESTAÑAS
// ============================================================
document.getElementById('nav-pestanas').addEventListener('click', (e) => {
  const boton = e.target.closest('.pestana');
  if (!boton) return;
  document.querySelectorAll('.pestana').forEach(b => b.classList.remove('activa'));
  boton.classList.add('activa');
  document.querySelectorAll('.vista').forEach(v => v.classList.add('oculto'));
  document.getElementById(`vista-${boton.dataset.vista}`).classList.remove('oculto');
});

// ============================================================
// VISTA: RESUMEN GENERAL
// ============================================================
async function cargarVistaResumen() {
  const { data: base, error: errBase } = await supabaseClient
    .from('base_gral')
    .select('parametro, valor, actualizado_en, estudios(nombre)');
  if (errBase) { console.error(errBase); return; }

  const nacionalDetalle = await consultarPaginado(() => supabaseClient
    .from('matriz_mensual')
    .select('mes, parametro, valor')
    .in('parametro', ['RECUPERO JUDICIAL', 'RECUPERO EXTRA', 'CAUSAS CON PAGOS JUD.', 'CAUSAS CON PAGOS EXT.'])
    .order('mes', { ascending: true })
  );
  // ---- KPIs (según el selector General/CFN/Megatone/Confina) ----
  cargarKpisGenerales(document.getElementById('selector-compania-general').value);
  cargarGraficoRecuperoPorCompania(document.getElementById('selector-compania-general').value);
  cargarSeguimientoTodasNacional(document.getElementById('selector-compania-general').value, granularidadTodasNacional);

  const ultimaActualizacion = base.reduce((max, f) => f.actualizado_en > max ? f.actualizado_en : max, '');
  document.getElementById('resumen-actualizado').textContent = ultimaActualizacion
    ? `Actualizado: ${new Date(ultimaActualizacion).toLocaleString('es-AR')}`
    : '';

  // ---- Gráfico: recupero mensual nacional, judicial vs extrajudicial + fichas ----
  const sumarPor = (parametro) => {
    const acumulado = {};
    nacionalDetalle.filter(f => f.parametro === parametro).forEach(f => { acumulado[f.mes] = (acumulado[f.mes] || 0) + Number(f.valor); });
    return acumulado;
  };
  const porMesJud = sumarPor('RECUPERO JUDICIAL');
  const porMesExtra = sumarPor('RECUPERO EXTRA');
  const porMesFichasJud = sumarPor('CAUSAS CON PAGOS JUD.');
  const porMesFichasExtra = sumarPor('CAUSAS CON PAGOS EXT.');
  const meses = [...new Set(nacionalDetalle.map(f => f.mes))].sort();
  dibujarSeguimientoJudExtra('grafico-recupero-nacional', meses,
    meses.map(m => porMesJud[m] || 0), meses.map(m => porMesExtra[m] || 0),
    meses.map(m => porMesFichasJud[m] || 0), meses.map(m => porMesFichasExtra[m] || 0));

  cargarTodosLosSeguimientos(false);
  cargarTodosLosPasosDetalle(false);

  // ---- Gráfico: barras por estudio (últ. mes cerrado) ----
  const filasUltimoMes = base.filter(f => f.parametro === 'RECUPERO ULT.MES CERRADO' && Number(f.valor) > 0)
    .sort((a, b) => b.valor - a.valor);
  dibujarBarras('grafico-barras-estudios',
    filasUltimoMes.map(f => f.estudios.nombre),
    filasUltimoMes.map(f => Number(f.valor)),
    COLOR_TINTA);

  // ---- Gráfico: torta judicial vs extrajudicial (último mes, todos los estudios) ----
  let totalJud = 0, totalExtra = 0;
  if (meses.length > 0) {
    const { data: judExtra } = await supabaseClient
      .from('matriz_mensual')
      .select('parametro, valor, mes')
      .in('parametro', ['RECUPERO JUDICIAL', 'RECUPERO EXTRA'])
      .eq('mes', meses[meses.length - 1]);
    totalJud = (judExtra || []).filter(f => f.parametro === 'RECUPERO JUDICIAL').reduce((a, f) => a + Number(f.valor), 0);
    totalExtra = (judExtra || []).filter(f => f.parametro === 'RECUPERO EXTRA').reduce((a, f) => a + Number(f.valor), 0);
  }
  dibujarTorta('grafico-torta-jud-extra', ['Judicial', 'Extrajudicial'], [totalJud, totalExtra], [COLOR_TINTA, COLOR_BRONCE]);

  // ---- Tabla detalle ----
  const porEstudio = {};
  base.forEach(f => {
    const nombre = f.estudios.nombre;
    porEstudio[nombre] = porEstudio[nombre] || {};
    porEstudio[nombre][f.parametro] = Number(f.valor);
  });
  const filasTabla = Object.entries(porEstudio).sort((a, b) => (b[1]['RECUPERO ULT.MES CERRADO'] || 0) - (a[1]['RECUPERO ULT.MES CERRADO'] || 0));
  document.querySelector('#tabla-base-gral tbody').innerHTML = filasTabla.map(([nombre, valores]) => `
    <tr>
      <td>${nombre}</td>
      <td class="numero">${formateadorMoneda.format(valores['RECUPERO ULT.MES CERRADO'] || 0)}</td>
      <td class="numero">${formateadorNumero.format(valores['EN GESTIÓN'] || 0)}</td>
      <td class="numero">${formateadorNumero.format(valores['INICIADAS'] || 0)}</td>
      <td class="numero">${formateadorNumero.format(valores['CON EMBARGO HABERES'] || 0)}</td>
      <td class="numero">${formateadorNumero.format(valores['CONTRAPARTE'] || 0)}</td>
    </tr>`).join('');
}

async function cargarKpisGenerales(companiaSeleccionada) {
  let valorFn, fichasJud = 0, fichasExt = 0;
  if (companiaSeleccionada === 'GENERAL') {
    const { data: base } = await supabaseClient.from('base_gral').select('parametro, valor');
    valorFn = (param) => (base || []).filter(f => f.parametro === param).reduce((acc, f) => acc + Number(f.valor), 0);
    const nacionalFichas = await consultarPaginado(() => supabaseClient
      .from('matriz_mensual').select('mes, parametro, valor')
      .in('parametro', ['CAUSAS CON PAGOS JUD.', 'CAUSAS CON PAGOS EXT.'])
      .order('mes', { ascending: true }));
    const meses = [...new Set(nacionalFichas.map(f => f.mes))].sort();
    const ultimoMes = meses.length ? meses[meses.length - 1] : null;
    fichasJud = nacionalFichas.filter(f => f.mes === ultimoMes && f.parametro === 'CAUSAS CON PAGOS JUD.').reduce((a, f) => a + Number(f.valor), 0);
    fichasExt = nacionalFichas.filter(f => f.mes === ultimoMes && f.parametro === 'CAUSAS CON PAGOS EXT.').reduce((a, f) => a + Number(f.valor), 0);
  } else {
    const { data: base } = await supabaseClient.from('base_gral_por_compania').select('parametro, valor').eq('compania', companiaSeleccionada);
    valorFn = (param) => Number((base || []).find(f => f.parametro === param)?.valor || 0);
    const filasMes = await consultarPaginado(() => supabaseClient
      .from('matriz_mensual').select('mes, parametro, valor')
      .in('parametro', [`CCP ${companiaSeleccionada} JUD.`, `CCP ${companiaSeleccionada} EXT.`])
      .order('mes', { ascending: true }));
    const meses = [...new Set(filasMes.map(f => f.mes))].sort();
    const ultimoMes = meses.length ? meses[meses.length - 1] : null;
    fichasJud = filasMes.filter(f => f.mes === ultimoMes && f.parametro === `CCP ${companiaSeleccionada} JUD.`).reduce((a, f) => a + Number(f.valor), 0);
    fichasExt = filasMes.filter(f => f.mes === ultimoMes && f.parametro === `CCP ${companiaSeleccionada} EXT.`).reduce((a, f) => a + Number(f.valor), 0);
  }
  const kpis = [
    { etiqueta: 'Recupero últ. mes', valor: formateadorMoneda.format(valorFn('RECUPERO ULT.MES CERRADO')) },
    { etiqueta: 'Fichas con pago (últ. mes)', valor: formateadorNumero.format(fichasJud + fichasExt) },
    { etiqueta: 'Fichas con pago judicial', valor: formateadorNumero.format(fichasJud) },
    { etiqueta: 'Fichas con pago extrajudicial', valor: formateadorNumero.format(fichasExt) },
    { etiqueta: 'Causas en gestión', valor: formateadorNumero.format(valorFn('EN GESTIÓN')) },
    { etiqueta: 'Causas iniciadas', valor: formateadorNumero.format(valorFn('INICIADAS')) },
    { etiqueta: 'Con embargo de haberes', valor: formateadorNumero.format(valorFn('CON EMBARGO HABERES')) },
  ];
  document.getElementById('kpis-generales').innerHTML = kpis.map(k => `
    <div class="tarjeta-kpi"><span class="valor">${k.valor}</span><span class="etiqueta">${k.etiqueta}</span></div>`).join('');
}

let granularidadTodasNacional = 'diario';

// Gráfico 1: Recupero mensual, con una línea + una barra de fichas por cada
// compañía (CFN/Megatone/Confina) — o, si se elige una compañía puntual en
// el desplegable, el mismo detalle judicial/extrajudicial que ya usa "Por
// Empresa" (mismos datos, mismo gráfico, reutilizado acá).
async function cargarGraficoRecuperoPorCompania(companiaSeleccionada) {
  const tituloEl = document.getElementById('titulo-grafico-recupero-companias');
  if (companiaSeleccionada === 'GENERAL') {
    tituloEl.textContent = 'Recupero mensual — por compañía';
    const filas = await consultarPaginado(() => supabaseClient
      .from('matriz_mensual').select('mes, parametro, valor')
      .in('parametro', ['RECUPERO CFN', 'RECUPERO EM', 'RECUPERO CONFINA', 'CCP CFN', 'CCP EM', 'CCP CONFINA'])
      .order('mes', { ascending: true }));
    const sumarPor = (parametro) => {
      const acc = {};
      filas.filter(f => f.parametro === parametro).forEach(f => { acc[f.mes] = (acc[f.mes] || 0) + Number(f.valor); });
      return acc;
    };
    const meses = [...new Set(filas.map(f => f.mes))].sort();
    const porCfn = sumarPor('RECUPERO CFN'), porEm = sumarPor('RECUPERO EM'), porConfina = sumarPor('RECUPERO CONFINA');
    const fichasCfn = sumarPor('CCP CFN'), fichasEm = sumarPor('CCP EM'), fichasConfina = sumarPor('CCP CONFINA');
    dibujarMultiSeguimiento('grafico-recupero-nacional-companias', meses,
      [
        { etiqueta: 'CFN SRL', datos: meses.map(m => porCfn[m] || 0), color: COLOR_CFN },
        { etiqueta: 'Electrónica Megatone SRL', datos: meses.map(m => porEm[m] || 0), color: COLOR_EM },
        { etiqueta: 'Confina SRL', datos: meses.map(m => porConfina[m] || 0), color: COLOR_CONFINA },
      ],
      [
        { etiqueta: 'Fichas CFN', datos: meses.map(m => fichasCfn[m] || 0), color: COLOR_CFN },
        { etiqueta: 'Fichas Megatone', datos: meses.map(m => fichasEm[m] || 0), color: COLOR_EM },
        { etiqueta: 'Fichas Confina', datos: meses.map(m => fichasConfina[m] || 0), color: COLOR_CONFINA },
      ]);
  } else {
    const nombreCia = { CFN: 'CFN', EM: 'Electrónica Megatone', CONFINA: 'Confina' }[companiaSeleccionada];
    tituloEl.textContent = `Recupero mensual — ${nombreCia} (judicial / extrajudicial)`;
    const filas = await consultarPaginado(() => supabaseClient
      .from('matriz_mensual').select('mes, parametro, valor')
      .in('parametro', [`RECUPERO ${companiaSeleccionada} JUD.`, `RECUPERO ${companiaSeleccionada} EXT.`, `CCP ${companiaSeleccionada} JUD.`, `CCP ${companiaSeleccionada} EXT.`])
      .order('mes', { ascending: true }));
    const sumarPor = (parametro) => {
      const acc = {};
      filas.filter(f => f.parametro === parametro).forEach(f => { acc[f.mes] = (acc[f.mes] || 0) + Number(f.valor); });
      return acc;
    };
    const meses = [...new Set(filas.map(f => f.mes))].sort();
    const porJud = sumarPor(`RECUPERO ${companiaSeleccionada} JUD.`), porExt = sumarPor(`RECUPERO ${companiaSeleccionada} EXT.`);
    const fichasJud = sumarPor(`CCP ${companiaSeleccionada} JUD.`), fichasExt = sumarPor(`CCP ${companiaSeleccionada} EXT.`);
    dibujarSeguimientoJudExtra('grafico-recupero-nacional-companias', meses,
      meses.map(m => porJud[m] || 0), meses.map(m => porExt[m] || 0),
      meses.map(m => fichasJud[m] || 0), meses.map(m => fichasExt[m] || 0));
  }
}

// Gráfico 2: mismo criterio, pero diario/semanal en vez de mensual.
async function cargarSeguimientoTodasNacional(companiaSeleccionada, granularidad) {
  granularidadTodasNacional = granularidad;
  const tituloEl = document.getElementById('titulo-grafico-seguimiento-todas');

  if (companiaSeleccionada === 'GENERAL') {
    tituloEl.textContent = 'Seguimiento — TODAS (Nacional)';
    const filas = await consultarPaginado(() => supabaseClient
      .from('recupero_diario')
      .select('fecha, valor_cfn, cantidad_cfn, valor_em, cantidad_em, valor_confina, cantidad_confina')
      .order('fecha', { ascending: true }));
    const agrupado = {};
    filas.forEach(f => {
      const clave = granularidad === 'semanal' ? claveDeSemana(f.fecha) : f.fecha;
      if (!agrupado[clave]) agrupado[clave] = { cfn: 0, em: 0, confina: 0, fCfn: 0, fEm: 0, fConfina: 0 };
      agrupado[clave].cfn += Number(f.valor_cfn || 0);
      agrupado[clave].em += Number(f.valor_em || 0);
      agrupado[clave].confina += Number(f.valor_confina || 0);
      agrupado[clave].fCfn += Number(f.cantidad_cfn || 0);
      agrupado[clave].fEm += Number(f.cantidad_em || 0);
      agrupado[clave].fConfina += Number(f.cantidad_confina || 0);
    });
    const claves = Object.keys(agrupado).sort();
    dibujarMultiSeguimiento('grafico-seguimiento-nacional-todas', claves,
      [
        { etiqueta: 'CFN SRL', datos: claves.map(c => agrupado[c].cfn), color: COLOR_CFN },
        { etiqueta: 'Electrónica Megatone SRL', datos: claves.map(c => agrupado[c].em), color: COLOR_EM },
        { etiqueta: 'Confina SRL', datos: claves.map(c => agrupado[c].confina), color: COLOR_CONFINA },
      ],
      [
        { etiqueta: 'Fichas CFN', datos: claves.map(c => agrupado[c].fCfn), color: COLOR_CFN },
        { etiqueta: 'Fichas Megatone', datos: claves.map(c => agrupado[c].fEm), color: COLOR_EM },
        { etiqueta: 'Fichas Confina', datos: claves.map(c => agrupado[c].fConfina), color: COLOR_CONFINA },
      ]);
  } else {
    const nombreCia = { CFN: 'CFN', EM: 'Electrónica Megatone', CONFINA: 'Confina' }[companiaSeleccionada];
    tituloEl.textContent = `Seguimiento — ${nombreCia} (Nacional)`;
    const filas = await consultarPaginado(() => supabaseClient
      .from('recupero_diario_detalle')
      .select('fecha, tipo, valor, cantidad_fichas')
      .eq('compania', companiaSeleccionada)
      .order('fecha', { ascending: true }));
    const agrupado = {};
    filas.forEach(f => {
      const clave = granularidad === 'semanal' ? claveDeSemana(f.fecha) : f.fecha;
      if (!agrupado[clave]) agrupado[clave] = { judicial: 0, extrajudicial: 0, fichasJudicial: 0, fichasExtrajudicial: 0 };
      if (f.tipo === 'JUDICIAL') {
        agrupado[clave].judicial += Number(f.valor || 0);
        agrupado[clave].fichasJudicial += Number(f.cantidad_fichas || 0);
      } else if (f.tipo === 'EXTRAJUDICIAL') {
        agrupado[clave].extrajudicial += Number(f.valor || 0);
        agrupado[clave].fichasExtrajudicial += Number(f.cantidad_fichas || 0);
      }
    });
    const claves = Object.keys(agrupado).sort();
    const sufijo = granularidad === 'semanal' ? ' (semana del)' : '';
    dibujarSeguimientoJudExtra('grafico-seguimiento-nacional-todas', claves,
      claves.map(c => agrupado[c].judicial), claves.map(c => agrupado[c].extrajudicial),
      claves.map(c => agrupado[c].fichasJudicial), claves.map(c => agrupado[c].fichasExtrajudicial), sufijo);
  }
}

document.getElementById('selector-compania-general').addEventListener('change', (e) => {
  cargarKpisGenerales(e.target.value);
  cargarGraficoRecuperoPorCompania(e.target.value);
  cargarSeguimientoTodasNacional(e.target.value, granularidadTodasNacional);
});

// ============================================================
// VISTA: POR ESTUDIO
// ============================================================
async function cargarSelectorEstudios() {
  const { data: estudios } = await supabaseClient.from('estudios').select('id, nombre').order('nombre');
  const selector = document.getElementById('selector-estudio');
  selector.innerHTML = estudios.map(e => `<option value="${e.id}">${e.nombre}</option>`).join('');
  selector.addEventListener('change', () => cargarVistaEstudio(selector.value));
  if (estudios.length) cargarVistaEstudio(estudios[0].id);
}

async function cargarKpisEstudio(estudioId, companiaSeleccionada) {
  let valorFn, fichasJud = 0, fichasExt = 0;
  if (companiaSeleccionada === 'GENERAL') {
    const { data: base } = await supabaseClient.from('base_gral').select('parametro, valor').eq('estudio_id', estudioId);
    valorFn = (param) => Number((base || []).find(f => f.parametro === param)?.valor || 0);
    const filasMes = await consultarPaginado(() => supabaseClient
      .from('matriz_mensual').select('mes, parametro, valor').eq('estudio_id', estudioId)
      .in('parametro', ['CAUSAS CON PAGOS JUD.', 'CAUSAS CON PAGOS EXT.']).order('mes', { ascending: true }));
    const meses = [...new Set(filasMes.map(f => f.mes))].sort();
    const ultimoMes = meses.length ? meses[meses.length - 1] : null;
    fichasJud = filasMes.filter(f => f.mes === ultimoMes && f.parametro === 'CAUSAS CON PAGOS JUD.').reduce((a, f) => a + Number(f.valor), 0);
    fichasExt = filasMes.filter(f => f.mes === ultimoMes && f.parametro === 'CAUSAS CON PAGOS EXT.').reduce((a, f) => a + Number(f.valor), 0);
  } else {
    const { data: base } = await supabaseClient.from('base_gral_por_estudio_compania').select('parametro, valor')
      .eq('estudio_id', estudioId).eq('compania', companiaSeleccionada);
    valorFn = (param) => Number((base || []).find(f => f.parametro === param)?.valor || 0);
    const filasMes = await consultarPaginado(() => supabaseClient
      .from('matriz_mensual').select('mes, parametro, valor').eq('estudio_id', estudioId)
      .in('parametro', [`CCP ${companiaSeleccionada} JUD.`, `CCP ${companiaSeleccionada} EXT.`])
      .order('mes', { ascending: true }));
    const meses = [...new Set(filasMes.map(f => f.mes))].sort();
    const ultimoMes = meses.length ? meses[meses.length - 1] : null;
    fichasJud = filasMes.filter(f => f.mes === ultimoMes && f.parametro === `CCP ${companiaSeleccionada} JUD.`).reduce((a, f) => a + Number(f.valor), 0);
    fichasExt = filasMes.filter(f => f.mes === ultimoMes && f.parametro === `CCP ${companiaSeleccionada} EXT.`).reduce((a, f) => a + Number(f.valor), 0);
  }
  document.getElementById('kpis-estudio').innerHTML = [
    { etiqueta: 'Recupero últ. mes', valor: formateadorMoneda.format(valorFn('RECUPERO ULT.MES CERRADO')) },
    { etiqueta: 'Fichas con pago (últ. mes)', valor: formateadorNumero.format(fichasJud + fichasExt) },
    { etiqueta: 'Fichas con pago judicial', valor: formateadorNumero.format(fichasJud) },
    { etiqueta: 'Fichas con pago extrajudicial', valor: formateadorNumero.format(fichasExt) },
    { etiqueta: 'En gestión', valor: formateadorNumero.format(valorFn('EN GESTIÓN')) },
    { etiqueta: 'Iniciadas', valor: formateadorNumero.format(valorFn('INICIADAS')) },
    { etiqueta: 'Con embargo de haberes', valor: formateadorNumero.format(valorFn('CON EMBARGO HABERES')) },
    { etiqueta: 'Contraparte', valor: formateadorNumero.format(valorFn('CONTRAPARTE')) },
  ].map(k => `<div class="tarjeta-kpi"><span class="valor">${k.valor}</span><span class="etiqueta">${k.etiqueta}</span></div>`).join('');
}

document.getElementById('selector-compania-estudio').addEventListener('change', (e) => {
  if (estudioSeleccionadoActual) cargarKpisEstudio(estudioSeleccionadoActual, e.target.value);
});

async function cargarVistaEstudio(estudioId) {
  estudioSeleccionadoActual = estudioId;
  cargarKpisEstudio(estudioId, document.getElementById('selector-compania-estudio').value);

  const filas = await consultarPaginado(() => supabaseClient
    .from('matriz_mensual')
    .select('mes, parametro, valor')
    .eq('estudio_id', estudioId)
    .order('mes', { ascending: true })
  );
  if (!filas) return;

  const meses = [...new Set(filas.map(f => f.mes))].sort();
  const porParametro = (param) => meses.map(m => Number((filas.find(f => f.mes === m && f.parametro === param) || {}).valor || 0));

  dibujarSeguimientoJudExtra('grafico-estudio-recupero', meses,
    porParametro('RECUPERO JUDICIAL'), porParametro('RECUPERO EXTRA'),
    porParametro('CAUSAS CON PAGOS JUD.'), porParametro('CAUSAS CON PAGOS EXT.'));

  const ultimoMes = meses[meses.length - 1];
  const valorEn = (param) => Number((filas.find(f => f.mes === ultimoMes && f.parametro === param) || {}).valor || 0);
  dibujarBarras('grafico-estudio-companias', ['CFN', 'Megatone', 'Confina'],
    [valorEn('RECUPERO CFN'), valorEn('RECUPERO EM'), valorEn('RECUPERO CONFINA')], COLOR_BRONCE);

  cargarTodosLosSeguimientos(true, estudioId);
  cargarTodosLosPasosDetalle(true, estudioId);
}

// ============================================================
// VISTA: POR EMPRESA (CFN / Megatone / Confina, a nivel nacional)
// ============================================================
let companiaSeleccionadaActual = 'CFN';
let granularidadEmpresa = 'diario';

document.getElementById('selector-empresa').addEventListener('change', (e) => {
  cargarVistaEmpresa(e.target.value);
});

async function cargarVistaEmpresa(compania) {
  companiaSeleccionadaActual = compania;

  const { data: base } = await supabaseClient.from('base_gral_por_compania').select('parametro, valor').eq('compania', compania);
  const valorBase = (param) => Number((base || []).find(f => f.parametro === param)?.valor || 0);

  const nombreParam = { CFN: 'CFN', EM: 'EM', CONFINA: 'CONFINA' }[compania];
  const filas = await consultarPaginado(() => supabaseClient
    .from('matriz_mensual')
    .select('mes, parametro, valor')
    .in('parametro', [`RECUPERO ${nombreParam} JUD.`, `RECUPERO ${nombreParam} EXT.`, `CCP ${nombreParam} JUD.`, `CCP ${nombreParam} EXT.`])
    .order('mes', { ascending: true })
  );
  const sumarPorMes = (parametro) => {
    const acumulado = {};
    filas.filter(f => f.parametro === parametro).forEach(f => { acumulado[f.mes] = (acumulado[f.mes] || 0) + Number(f.valor); });
    return acumulado;
  };
  const porMesJud = sumarPorMes(`RECUPERO ${nombreParam} JUD.`);
  const porMesExt = sumarPorMes(`RECUPERO ${nombreParam} EXT.`);
  const porMesFichasJud = sumarPorMes(`CCP ${nombreParam} JUD.`);
  const porMesFichasExt = sumarPorMes(`CCP ${nombreParam} EXT.`);
  const meses = [...new Set(filas.map(f => f.mes))].sort();
  const ultimoMes = meses.length ? meses[meses.length - 1] : null;
  const fichasJud = porMesFichasJud[ultimoMes] || 0;
  const fichasExt = porMesFichasExt[ultimoMes] || 0;

  document.getElementById('kpis-empresa').innerHTML = [
    { etiqueta: 'Recupero últ. mes', valor: formateadorMoneda.format(valorBase('RECUPERO ULT.MES CERRADO')) },
    { etiqueta: 'Fichas con pago (últ. mes)', valor: formateadorNumero.format(fichasJud + fichasExt) },
    { etiqueta: 'Fichas con pago judicial', valor: formateadorNumero.format(fichasJud) },
    { etiqueta: 'Fichas con pago extrajudicial', valor: formateadorNumero.format(fichasExt) },
    { etiqueta: 'En gestión', valor: formateadorNumero.format(valorBase('EN GESTIÓN')) },
    { etiqueta: 'Iniciadas', valor: formateadorNumero.format(valorBase('INICIADAS')) },
    { etiqueta: 'Con embargo de haberes', valor: formateadorNumero.format(valorBase('CON EMBARGO HABERES')) },
    { etiqueta: 'Contraparte', valor: formateadorNumero.format(valorBase('CONTRAPARTE')) },
  ].map(k => `<div class="tarjeta-kpi"><span class="valor">${k.valor}</span><span class="etiqueta">${k.etiqueta}</span></div>`).join('');

  dibujarSeguimientoJudExtra('grafico-empresa-recupero', meses,
    meses.map(m => porMesJud[m] || 0), meses.map(m => porMesExt[m] || 0),
    meses.map(m => porMesFichasJud[m] || 0), meses.map(m => porMesFichasExt[m] || 0));

  cargarSeguimientoEmpresa(compania, granularidadEmpresa);
}

async function cargarSeguimientoEmpresa(compania, granularidad) {
  granularidadEmpresa = granularidad;
  const filas = await consultarPaginado(() => supabaseClient
    .from('recupero_diario_detalle')
    .select('fecha, tipo, valor, cantidad_fichas')
    .eq('compania', compania)
    .order('fecha', { ascending: true })
  );

  const agrupado = {};
  filas.forEach(f => {
    const clave = granularidad === 'semanal' ? claveDeSemana(f.fecha) : f.fecha;
    if (!agrupado[clave]) agrupado[clave] = { judicial: 0, extrajudicial: 0, fichasJudicial: 0, fichasExtrajudicial: 0 };
    if (f.tipo === 'JUDICIAL') {
      agrupado[clave].judicial += Number(f.valor || 0);
      agrupado[clave].fichasJudicial += Number(f.cantidad_fichas || 0);
    } else if (f.tipo === 'EXTRAJUDICIAL') {
      agrupado[clave].extrajudicial += Number(f.valor || 0);
      agrupado[clave].fichasExtrajudicial += Number(f.cantidad_fichas || 0);
    }
  });
  const claves = Object.keys(agrupado).sort();
  const sufijo = granularidad === 'semanal' ? ' (semana del)' : '';
  dibujarSeguimientoJudExtra('grafico-seguimiento-empresa', claves,
    claves.map(c => agrupado[c].judicial), claves.map(c => agrupado[c].extrajudicial),
    claves.map(c => agrupado[c].fichasJudicial), claves.map(c => agrupado[c].fichasExtrajudicial),
    sufijo);
}

// ============================================================
// SEGUIMIENTO DIARIO/SEMANAL DEL RECUPERO (nacional y por estudio,
// total y por compañía — judicial vs extrajudicial, con sus fichas)
// ============================================================
// Mapea cada "objetivo" del selector a: qué compañía filtrar en
// recupero_diario_detalle, si es a nivel nacional o de un estudio, y en qué
// canvas dibujarlo.
const CONFIG_SEGUIMIENTO = {
  'nacional': { compania: 'TOTAL', esEstudio: false, canvas: 'grafico-seguimiento-nacional' },
  'estudio': { compania: 'TOTAL', esEstudio: true, canvas: 'grafico-seguimiento-estudio' },
  'estudio-cfn': { compania: 'CFN', esEstudio: true, canvas: 'grafico-seguimiento-estudio-cfn' },
  'estudio-em': { compania: 'EM', esEstudio: true, canvas: 'grafico-seguimiento-estudio-em' },
  'estudio-confina': { compania: 'CONFINA', esEstudio: true, canvas: 'grafico-seguimiento-estudio-confina' },
};
const granularidadPorObjetivo = {}; // 'diario' por defecto para cada uno
let estudioSeleccionadoActual = null;

// Agrupa una fecha en la semana a la que pertenece (lunes de esa semana),
// para el detalle "semanal" — se arma acá mismo, no hace falta guardar nada
// aparte: el dato diario ya alcanza.
function claveDeSemana(fechaIso) {
  const d = new Date(fechaIso + 'T00:00:00');
  const diaSemana = d.getDay() || 7; // domingo=0 -> tratarlo como 7
  d.setDate(d.getDate() - diaSemana + 1); // lunes de esa semana
  return d.toISOString().slice(0, 10);
}

async function cargarSeguimiento(objetivo, granularidad, estudioId) {
  const config = CONFIG_SEGUIMIENTO[objetivo];
  if (!config) return;
  granularidadPorObjetivo[objetivo] = granularidad;
  if (config.esEstudio && !estudioId) return; // todavía no hay estudio elegido

  const filas = await consultarPaginado(() => {
    let q = supabaseClient.from('recupero_diario_detalle')
      .select('fecha, tipo, valor, cantidad_fichas')
      .eq('compania', config.compania)
      .order('fecha', { ascending: true });
    if (config.esEstudio) q = q.eq('estudio_id', estudioId);
    return q;
  });

  const agrupado = {};
  filas.forEach(f => {
    const clave = granularidad === 'semanal' ? claveDeSemana(f.fecha) : f.fecha;
    if (!agrupado[clave]) agrupado[clave] = { judicial: 0, extrajudicial: 0, fichasJudicial: 0, fichasExtrajudicial: 0 };
    if (f.tipo === 'JUDICIAL') {
      agrupado[clave].judicial += Number(f.valor || 0);
      agrupado[clave].fichasJudicial += Number(f.cantidad_fichas || 0);
    } else if (f.tipo === 'EXTRAJUDICIAL') {
      agrupado[clave].extrajudicial += Number(f.valor || 0);
      agrupado[clave].fichasExtrajudicial += Number(f.cantidad_fichas || 0);
    }
  });
  const claves = Object.keys(agrupado).sort();
  const sufijo = granularidad === 'semanal' ? ' (semana del)' : '';
  dibujarSeguimientoJudExtra(config.canvas, claves,
    claves.map(c => agrupado[c].judicial), claves.map(c => agrupado[c].extrajudicial),
    claves.map(c => agrupado[c].fichasJudicial), claves.map(c => agrupado[c].fichasExtrajudicial),
    sufijo);
}

function cargarTodosLosSeguimientos(esEstudio, estudioId) {
  Object.keys(CONFIG_SEGUIMIENTO)
    .filter(objetivo => CONFIG_SEGUIMIENTO[objetivo].esEstudio === esEstudio)
    .forEach(objetivo => cargarSeguimiento(objetivo, granularidadPorObjetivo[objetivo] || 'diario', estudioId));
}

document.querySelectorAll('.selector-granularidad').forEach(selector => {
  selector.addEventListener('click', (e) => {
    const boton = e.target.closest('.chip-granularidad');
    if (!boton) return;
    selector.querySelectorAll('.chip-granularidad').forEach(b => b.classList.remove('activa'));
    boton.classList.add('activa');
    const objetivo = selector.dataset.objetivo;
    const granularidad = boton.dataset.granularidad;
    if (objetivo === 'empresa') {
      cargarSeguimientoEmpresa(companiaSeleccionadaActual, granularidad);
      return;
    }
    if (objetivo === 'todas') {
      cargarSeguimientoTodasNacional(document.getElementById('selector-compania-general').value, granularidad);
      return;
    }
    const config = CONFIG_SEGUIMIENTO[objetivo];
    cargarSeguimiento(objetivo, granularidad, config.esEstudio ? estudioSeleccionadoActual : null);
  });
});

// ============================================================
// CÉDULAS DE SENTENCIA / LIQUIDACIONES / EMBARGOS, POR COMPAÑÍA
// (nacional y por estudio — cantidad de fichas por mes, sin selector de
// granularidad porque Pasos Procesales se carga a nivel mensual)
// ============================================================
const CONFIG_PASOS_DETALLE = {
  'nacional-total': { compania: 'TOTAL', esEstudio: false, canvas: 'grafico-pasos-nacional-total' },
  'nacional-cfn': { compania: 'CFN', esEstudio: false, canvas: 'grafico-pasos-nacional-cfn' },
  'nacional-em': { compania: 'EM', esEstudio: false, canvas: 'grafico-pasos-nacional-em' },
  'nacional-confina': { compania: 'CONFINA', esEstudio: false, canvas: 'grafico-pasos-nacional-confina' },
  'estudio-total': { compania: 'TOTAL', esEstudio: true, canvas: 'grafico-pasos-estudio-total' },
  'estudio-cfn': { compania: 'CFN', esEstudio: true, canvas: 'grafico-pasos-estudio-cfn' },
  'estudio-em': { compania: 'EM', esEstudio: true, canvas: 'grafico-pasos-estudio-em' },
  'estudio-confina': { compania: 'CONFINA', esEstudio: true, canvas: 'grafico-pasos-estudio-confina' },
};

async function cargarPasosDetalle(objetivo, estudioId) {
  const config = CONFIG_PASOS_DETALLE[objetivo];
  if (!config) return;
  if (config.esEstudio && !estudioId) return;

  const filas = await consultarPaginado(() => {
    let q = supabaseClient.from('pasos_mensual_detalle')
      .select('mes, metrica, cantidad_fichas')
      .eq('compania', config.compania)
      .order('mes', { ascending: true });
    if (config.esEstudio) q = q.eq('estudio_id', estudioId);
    return q;
  });

  const agrupado = {};
  filas.forEach(f => {
    if (!agrupado[f.mes]) agrupado[f.mes] = { sentencia: 0, liquidacion: 0, embargo: 0 };
    if (f.metrica === 'SENTENCIA') agrupado[f.mes].sentencia += Number(f.cantidad_fichas || 0);
    else if (f.metrica === 'LIQUIDACION') agrupado[f.mes].liquidacion += Number(f.cantidad_fichas || 0);
    else if (f.metrica === 'EMBARGO') agrupado[f.mes].embargo += Number(f.cantidad_fichas || 0);
  });
  const meses = Object.keys(agrupado).sort();
  dibujarPasosPorMes(config.canvas, meses,
    meses.map(m => agrupado[m].sentencia), meses.map(m => agrupado[m].liquidacion), meses.map(m => agrupado[m].embargo));
}

function cargarTodosLosPasosDetalle(esEstudio, estudioId) {
  Object.keys(CONFIG_PASOS_DETALLE)
    .filter(objetivo => CONFIG_PASOS_DETALLE[objetivo].esEstudio === esEstudio)
    .forEach(objetivo => cargarPasosDetalle(objetivo, estudioId));
}


// Después de subir los archivos, el servidor sigue procesando en segundo
// plano. En vez de obligar a refrescar la página a mano, consultamos el
// Historial de Cargas cada 8 segundos hasta ver que terminó (ok o error), y
// ahí actualizamos el dashboard solos.
async function esperarFinalizacionYRefrescar(estadoEl, horaInicioIso, mensajeExito) {
  const maxIntentos = 90; // 90 x 8s = 12 minutos como máximo
  for (let intento = 0; intento < maxIntentos; intento++) {
    await new Promise(r => setTimeout(r, 8000));
    const { data } = await supabaseClient
      .from('cargas_log')
      .select('subido_en, estado, mensaje')
      .gt('subido_en', horaInicioIso)
      .order('subido_en', { ascending: false })
      .limit(5);
    const filaFinal = (data || []).find(f => f.estado === 'ok' || f.estado === 'error');
    if (filaFinal) {
      if (filaFinal.estado === 'ok') {
        estadoEl.textContent = mensajeExito || `Listo: ${filaFinal.mensaje}`;
        estadoEl.className = 'mensaje-estado ok';
        cargarVistaResumen();
        cargarSelectorEstudios();
        cargarVistaEmpresa(companiaSeleccionadaActual);
      } else {
        estadoEl.textContent = `Error: ${filaFinal.mensaje}`;
        estadoEl.className = 'mensaje-estado error';
      }
      cargarLogCargas();
      return;
    }
  }
  estadoEl.textContent = 'Sigue procesando hace rato — revisá el Historial de Cargas o los logs de Render.';
  estadoEl.className = 'mensaje-estado';
  cargarLogCargas();
}

document.getElementById('form-carga').addEventListener('submit', async (e) => {
  e.preventDefault();
  const estadoEl = document.getElementById('carga-estado');
  const boton = document.getElementById('btn-cargar');
  estadoEl.textContent = 'Subiendo los archivos… con archivos grandes puede tardar varios minutos, no cierres esta pestaña.';
  estadoEl.className = 'mensaje-estado';
  boton.disabled = true;
  const horaInicio = new Date().toISOString();

  const { data: { session } } = await supabaseClient.auth.getSession();
  const formData = new FormData();
  formData.append('cartera', document.getElementById('archivo-cartera').files[0]);
  formData.append('recupero', document.getElementById('archivo-recupero').files[0]);
  formData.append('juzgados', document.getElementById('archivo-juzgados').files[0]);
  formData.append('abogados', document.getElementById('archivo-abogados').files[0]);
  formData.append('pasos', document.getElementById('archivo-pasos').files[0]);

  try {
    const respuesta = await fetch(`${CONFIG.BACKEND_URL}/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${session.access_token}` },
      body: formData,
    });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.detail || 'Error desconocido');

    estadoEl.textContent = 'Archivos recibidos. Procesando en el servidor — esta pantalla se va a actualizar sola cuando termine, no hace falta que la refresques.';
    estadoEl.className = 'mensaje-estado ok';
    cargarLogCargas();
    esperarFinalizacionYRefrescar(estadoEl, horaInicio, 'Listo — la Matriz ya está actualizada.');
  } catch (err) {
    estadoEl.textContent = `Error: ${err.message}`;
    estadoEl.className = 'mensaje-estado error';
  } finally {
    boton.disabled = false;
  }
});

document.getElementById('form-incremental').addEventListener('submit', async (e) => {
  e.preventDefault();
  const estadoEl = document.getElementById('incremental-estado');
  const boton = document.getElementById('btn-incremental');
  estadoEl.textContent = 'Subiendo… puede tardar unos minutos, no cierres esta pestaña.';
  estadoEl.className = 'mensaje-estado';
  boton.disabled = true;
  const horaInicio = new Date().toISOString();

  const { data: { session } } = await supabaseClient.auth.getSession();
  const mesElegido = document.getElementById('incremental-mes').value; // 'YYYY-MM-DD'
  const formData = new FormData();
  formData.append('mes', mesElegido);
  formData.append('altas', document.getElementById('incremental-altas').files[0]);
  formData.append('bajas', document.getElementById('incremental-bajas').files[0]);
  formData.append('recupero_mes', document.getElementById('incremental-recupero').files[0]);
  formData.append('pasos_mes', document.getElementById('incremental-pasos').files[0]);
  const archivoJuzgados = document.getElementById('incremental-juzgados').files[0];
  const archivoAbogados = document.getElementById('incremental-abogados').files[0];
  if (archivoJuzgados) formData.append('juzgados', archivoJuzgados);
  if (archivoAbogados) formData.append('abogados', archivoAbogados);

  try {
    const respuesta = await fetch(`${CONFIG.BACKEND_URL}/upload-incremental`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${session.access_token}` },
      body: formData,
    });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.detail || 'Error desconocido');

    estadoEl.textContent = 'Archivos recibidos. Procesando en el servidor — esta pantalla se va a actualizar sola cuando termine, no hace falta que la refresques.';
    estadoEl.className = 'mensaje-estado ok';
    cargarLogCargas();
    esperarFinalizacionYRefrescar(estadoEl, horaInicio, 'Listo — la Matriz ya está actualizada.');
  } catch (err) {
    estadoEl.textContent = `Error: ${err.message}`;
    estadoEl.className = 'mensaje-estado error';
  } finally {
    boton.disabled = false;
  }
});

document.getElementById('form-backfill-compania').addEventListener('submit', async (e) => {
  e.preventDefault();
  const estadoEl = document.getElementById('backfill-estado');
  const boton = document.getElementById('btn-backfill-compania');
  estadoEl.textContent = 'Subiendo…';
  estadoEl.className = 'mensaje-estado';
  boton.disabled = true;
  const horaInicio = new Date().toISOString();

  const { data: { session } } = await supabaseClient.auth.getSession();
  const formData = new FormData();
  formData.append('archivo', document.getElementById('backfill-archivo').files[0]);

  try {
    const respuesta = await fetch(`${CONFIG.BACKEND_URL}/backfill-compania`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${session.access_token}` },
      body: formData,
    });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.detail || 'Error desconocido');

    estadoEl.textContent = 'Procesando… esta pantalla se va a actualizar sola cuando termine.';
    estadoEl.className = 'mensaje-estado ok';
    cargarLogCargas();
    esperarFinalizacionYRefrescar(estadoEl, horaInicio, 'Listo — la Compañía ya está actualizada. Revisá "Por Empresa".');
  } catch (err) {
    estadoEl.textContent = `Error: ${err.message}`;
    estadoEl.className = 'mensaje-estado error';
  } finally {
    boton.disabled = false;
  }
});

async function cargarLogCargas() {
  const { data: log } = await supabaseClient
    .from('cargas_log')
    .select('subido_en, subido_por, estado, mensaje')
    .order('subido_en', { ascending: false })
    .limit(20);
  const filasHtml = (log || []).map(f => `
    <tr>
      <td>${new Date(f.subido_en).toLocaleString('es-AR')}</td>
      <td>${f.subido_por || ''}</td>
      <td>${f.estado}</td>
      <td>${f.mensaje || ''}</td>
    </tr>`).join('');
  document.querySelector('#tabla-log tbody').innerHTML = filasHtml;
  const tablaIncremental = document.querySelector('#tabla-log-incremental tbody');
  if (tablaIncremental) tablaIncremental.innerHTML = filasHtml;
}

// ============================================================
// HELPERS DE GRÁFICOS (Chart.js)
// ============================================================
function destruirSiExiste(id) {
  if (graficos[id]) { graficos[id].destroy(); delete graficos[id]; }
}

function dibujarLinea(id, etiquetas, series) {
  destruirSiExiste(id);
  const ctx = document.getElementById(id);
  graficos[id] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: etiquetas,
      datasets: series.map(s => ({
        label: s.etiqueta, data: s.datos, borderColor: s.color, backgroundColor: s.color + '22',
        tension: 0.25, fill: series.length === 1, pointRadius: 2,
      })),
    },
    options: { responsive: true, plugins: { legend: { display: series.length > 1 } } },
  });
}

// Gráfico combinado: montos en $ (línea, eje izquierdo) + cantidad de fichas
// (barras, eje derecho) — para mostrar cuántas causas componen cada monto.
function dibujarLineaConFichas(id, etiquetas, lineas, datosFichas) {
  destruirSiExiste(id);
  const ctx = document.getElementById(id);
  const datasets = [
    ...lineas.map(s => ({
      type: 'line', label: s.etiqueta, data: s.datos, borderColor: s.color,
      backgroundColor: s.color + '22', tension: 0.25, fill: lineas.length === 1,
      pointRadius: 2, yAxisID: 'y',
    })),
    {
      type: 'bar', label: 'Cantidad de fichas', data: datosFichas,
      backgroundColor: 'rgba(37, 64, 74, 0.18)', yAxisID: 'y1', order: 99,
    },
  ];
  graficos[id] = new Chart(ctx, {
    type: 'bar',
    data: { labels: etiquetas, datasets },
    options: {
      responsive: true,
      plugins: { legend: { display: true } },
      scales: {
        y: { position: 'left', title: { display: true, text: 'Monto ($)' } },
        y1: { position: 'right', title: { display: true, text: 'Cantidad de fichas' }, grid: { drawOnChartArea: false } },
      },
    },
  });
}

// Gráfico combinado con 2 líneas (judicial/extrajudicial, eje izquierdo en $)
// y 2 barras (cantidad de fichas judicial/extrajudicial, eje derecho) — para
// diferenciar completamente ambos circuitos en un mismo gráfico.
function dibujarSeguimientoJudExtra(id, etiquetas, valorJudicial, valorExtrajudicial, fichasJudicial, fichasExtrajudicial, sufijo) {
  destruirSiExiste(id);
  const ctx = document.getElementById(id);
  const valorTotal = etiquetas.map((_, i) => Number(valorJudicial[i] || 0) + Number(valorExtrajudicial[i] || 0));
  const fichasTotal = etiquetas.map((_, i) => Number(fichasJudicial[i] || 0) + Number(fichasExtrajudicial[i] || 0));
  const datasets = [
    {
      type: 'line', label: 'Total' + (sufijo || ''), data: valorTotal, borderColor: COLOR_BRONCE,
      backgroundColor: COLOR_BRONCE + '22', tension: 0.25, pointRadius: 2, yAxisID: 'y', borderWidth: 2.5,
    },
    {
      type: 'line', label: 'Judicial' + (sufijo || ''), data: valorJudicial, borderColor: COLOR_JUDICIAL,
      backgroundColor: COLOR_JUDICIAL + '22', tension: 0.25, pointRadius: 2, yAxisID: 'y',
    },
    {
      type: 'line', label: 'Extrajudicial' + (sufijo || ''), data: valorExtrajudicial, borderColor: COLOR_EXTRAJUDICIAL,
      backgroundColor: COLOR_EXTRAJUDICIAL + '22', tension: 0.25, pointRadius: 2, yAxisID: 'y',
    },
    {
      type: 'bar', label: 'Fichas total', data: fichasTotal,
      backgroundColor: COLOR_BRONCE + '33', yAxisID: 'y1', order: 98,
    },
    {
      type: 'bar', label: 'Fichas judicial', data: fichasJudicial,
      backgroundColor: COLOR_JUDICIAL + '33', yAxisID: 'y1', order: 99,
    },
    {
      type: 'bar', label: 'Fichas extrajudicial', data: fichasExtrajudicial,
      backgroundColor: COLOR_EXTRAJUDICIAL + '33', yAxisID: 'y1', order: 99,
    },
  ];
  graficos[id] = new Chart(ctx, {
    type: 'bar',
    data: { labels: etiquetas, datasets },
    options: {
      responsive: true,
      plugins: { legend: { display: true } },
      scales: {
        y: { position: 'left', title: { display: true, text: 'Monto ($)' } },
        y1: { position: 'right', title: { display: true, text: 'Cantidad de fichas' }, grid: { drawOnChartArea: false } },
      },
    },
  });
}

// Versión genérica de dibujarSeguimientoJudExtra: en vez de 2 series fijas
// (judicial/extrajudicial), recibe un array de líneas y un array de barras
// — se usa para el desglose por compañía (CFN/Megatone/Confina), que son 3
// series en vez de 2.
// lineas / barras: [{ etiqueta, datos, color }]
function dibujarMultiSeguimiento(id, etiquetas, lineas, barras) {
  destruirSiExiste(id);
  const ctx = document.getElementById(id);
  const datasets = [
    ...lineas.map(l => ({
      type: 'line', label: l.etiqueta, data: l.datos, borderColor: l.color,
      backgroundColor: l.color + '22', tension: 0.25, pointRadius: 2, yAxisID: 'y',
    })),
    ...barras.map(b => ({
      type: 'bar', label: b.etiqueta, data: b.datos, backgroundColor: b.color + '33', yAxisID: 'y1', order: 99,
    })),
  ];
  graficos[id] = new Chart(ctx, {
    type: 'bar',
    data: { labels: etiquetas, datasets },
    options: {
      responsive: true,
      plugins: { legend: { display: true } },
      scales: {
        y: { position: 'left', title: { display: true, text: 'Monto ($)' } },
        y1: { position: 'right', title: { display: true, text: 'Cantidad de fichas' }, grid: { drawOnChartArea: false } },
      },
    },
  });
}

// Gráfico de las 3 métricas de Pasos Procesales (cédulas de sentencia,
// liquidaciones, embargos) por mes — todas son "cantidad de fichas", así que
// van en un solo eje, sin necesitar el doble eje que sí usan los de Recupero.
function dibujarPasosPorMes(id, etiquetas, sentencia, liquidacion, embargo) {
  destruirSiExiste(id);
  const ctx = document.getElementById(id);
  graficos[id] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: etiquetas,
      datasets: [
        { label: 'Cédulas de sentencia', data: sentencia, borderColor: COLOR_TINTA, backgroundColor: COLOR_TINTA + '22', tension: 0.25, pointRadius: 2 },
        { label: 'Liquidaciones', data: liquidacion, borderColor: COLOR_VERDE, backgroundColor: COLOR_VERDE + '22', tension: 0.25, pointRadius: 2 },
        { label: 'Embargos', data: embargo, borderColor: COLOR_BRONCE, backgroundColor: COLOR_BRONCE + '22', tension: 0.25, pointRadius: 2 },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: true } },
      scales: { y: { title: { display: true, text: 'Cantidad de fichas' } } },
    },
  });
}

function dibujarBarras(id, etiquetas, datos, color, extra) {
  destruirSiExiste(id);
  const ctx = document.getElementById(id);
  const datasets = [{ label: 'Valor', data: datos, backgroundColor: color }];
  if (extra) datasets.push({ label: extra.etiqueta2, data: extra.datos2, backgroundColor: extra.color2 });
  graficos[id] = new Chart(ctx, {
    type: 'bar',
    data: { labels: etiquetas, datasets },
    options: { responsive: true, plugins: { legend: { display: !!extra } } },
  });
}

function dibujarTorta(id, etiquetas, datos, colores) {
  destruirSiExiste(id);
  const ctx = document.getElementById(id);
  graficos[id] = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: etiquetas, datasets: [{ data: datos, backgroundColor: colores }] },
    options: { responsive: true },
  });
}

// ============================================================
// EXPORTAR INFORME COMPLETO A PDF
// ============================================================

// Dibuja un gráfico "fuera de pantalla" (no se ve en la página) solo para
// capturarlo como imagen y meterlo en el PDF. Se destruye apenas se usa.
async function renderizarGraficoParaPDF(tipo, etiquetas, datasets) {
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 380;
  const chart = new Chart(canvas, {
    type: tipo,
    data: {
      labels: etiquetas,
      datasets: datasets.map(d => ({ tension: 0.25, pointRadius: 0, borderWidth: 2, ...d })),
    },
    options: { responsive: false, animation: false, plugins: { legend: { display: datasets.length > 1 } } },
  });
  await new Promise(r => setTimeout(r, 60));
  const imagen = canvas.toDataURL('image/png');
  chart.destroy();
  return imagen;
}

document.getElementById('btn-exportar-pdf').addEventListener('click', async () => {
  const boton = document.getElementById('btn-exportar-pdf');
  boton.disabled = true;
  const textoOriginal = boton.textContent;
  boton.textContent = 'Generando PDF… puede tardar un minuto';

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const anchoPagina = doc.internal.pageSize.getWidth();
    const margen = 40;
    const anchoUtil = anchoPagina - margen * 2;

    // ---- Traer todos los datos necesarios ----
    const { data: estudios } = await supabaseClient.from('estudios').select('id, nombre').order('nombre');
    const base = await consultarPaginado(() => supabaseClient.from('base_gral').select('parametro, valor, estudios(nombre)'));
    const matrizCompleta = await consultarPaginado(() => supabaseClient.from('matriz_mensual').select('mes, parametro, valor, estudio_id'));

    const suma = (param) => base.filter(f => f.parametro === param).reduce((a, f) => a + Number(f.valor), 0);

    // ---- Página 1: Resumen General ----
    doc.setFontSize(18);
    doc.text('Matriz de Recupero — Informe General', margen, 50);
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(`Generado: ${new Date().toLocaleString('es-AR')}`, margen, 66);
    doc.setTextColor(0);

    doc.setFontSize(11);
    let y = 95;
    [
      ['Recupero últ. mes (nacional)', formateadorMoneda.format(suma('RECUPERO ULT.MES CERRADO'))],
      ['Causas en gestión', formateadorNumero.format(suma('EN GESTIÓN'))],
      ['Causas iniciadas', formateadorNumero.format(suma('INICIADAS'))],
      ['Con embargo de haberes', formateadorNumero.format(suma('CON EMBARGO HABERES'))],
    ].forEach(([etq, val]) => { doc.text(`${etq}: ${val}`, margen, y); y += 16; });

    const porMesNacional = {};
    matrizCompleta.filter(f => f.parametro === 'RECUPERO').forEach(f => {
      porMesNacional[f.mes] = (porMesNacional[f.mes] || 0) + Number(f.valor);
    });
    const mesesNacional = Object.keys(porMesNacional).sort();
    if (mesesNacional.length) {
      const imgNacional = await renderizarGraficoParaPDF('line', mesesNacional, [
        { label: 'Recupero total', data: mesesNacional.map(m => porMesNacional[m]), borderColor: COLOR_BRONCE, backgroundColor: COLOR_BRONCE + '22', fill: true },
      ]);
      doc.addImage(imgNacional, 'PNG', margen, y + 8, anchoUtil, 200);
      y += 220;
    }

    const porEstudioBase = {};
    base.forEach(f => {
      const nombre = f.estudios.nombre;
      porEstudioBase[nombre] = porEstudioBase[nombre] || {};
      porEstudioBase[nombre][f.parametro] = Number(f.valor);
    });
    const filasTabla = Object.entries(porEstudioBase)
      .sort((a, b) => (b[1]['RECUPERO ULT.MES CERRADO'] || 0) - (a[1]['RECUPERO ULT.MES CERRADO'] || 0))
      .map(([nombre, v]) => [
        nombre,
        formateadorMoneda.format(v['RECUPERO ULT.MES CERRADO'] || 0),
        formateadorNumero.format(v['EN GESTIÓN'] || 0),
        formateadorNumero.format(v['INICIADAS'] || 0),
        formateadorNumero.format(v['CON EMBARGO HABERES'] || 0),
      ]);
    doc.autoTable({
      startY: y,
      head: [['Estudio', 'Recupero últ. mes', 'En gestión', 'Iniciadas', 'Con embargo']],
      body: filasTabla,
      margin: { left: margen, right: margen },
      styles: { fontSize: 8 },
      headStyles: { fillColor: [37, 64, 74] },
    });

    // ---- Una página por estudio ----
    for (const est of estudios) {
      doc.addPage();
      const filasEst = matrizCompleta.filter(f => f.estudio_id === est.id);
      const mesesEst = [...new Set(filasEst.map(f => f.mes))].sort();
      const porParam = (p) => mesesEst.map(m => Number((filasEst.find(f => f.mes === m && f.parametro === p) || {}).valor || 0));

      doc.setFontSize(16);
      doc.text(est.nombre, margen, 50);

      let yEst = 75;
      if (mesesEst.length) {
        const imgEstudio = await renderizarGraficoParaPDF('line', mesesEst, [
          { label: 'Total', data: porParam('RECUPERO'), borderColor: COLOR_BRONCE },
          { label: 'Judicial', data: porParam('RECUPERO JUDICIAL'), borderColor: COLOR_TINTA },
          { label: 'Extrajudicial', data: porParam('RECUPERO EXTRA'), borderColor: COLOR_VERDE },
        ]);
        doc.addImage(imgEstudio, 'PNG', margen, yEst, anchoUtil, 190);
        yEst += 205;
      } else {
        doc.setFontSize(10);
        doc.text('Sin datos mensuales cargados para este estudio.', margen, yEst);
        yEst += 20;
      }

      const datosBase = porEstudioBase[est.nombre] || {};
      doc.setFontSize(10);
      [
        ['En gestión', datosBase['EN GESTIÓN']], ['Iniciadas', datosBase['INICIADAS']],
        ['Con embargo de haberes', datosBase['CON EMBARGO HABERES']], ['Contraparte', datosBase['CONTRAPARTE']],
        ['5 años sin pagos', datosBase['5 AÑOS SIN PAGOS']],
      ].forEach(([etq, val]) => {
        doc.text(`${etq}: ${formateadorNumero.format(val || 0)}`, margen, yEst);
        yEst += 15;
      });
    }

    doc.save(`matriz-recupero-${new Date().toISOString().slice(0, 10)}.pdf`);
  } catch (err) {
    console.error(err);
    alert('Error generando el PDF: ' + err.message);
  } finally {
    boton.disabled = false;
    boton.textContent = textoOriginal;
  }
});

// Los gráficos dentro de un <details> pueden quedar mal dimensionados si se
// dibujaron mientras estaba cerrado — al reabrir, le pedimos a Chart.js que
// vuelva a calcular el tamaño.
document.querySelectorAll('details.desplegable').forEach(detalle => {
  detalle.addEventListener('toggle', () => {
    if (!detalle.open) return;
    const canvas = detalle.querySelector('canvas');
    if (canvas && graficos[canvas.id]) graficos[canvas.id].resize();
  });
});

iniciarApp();
