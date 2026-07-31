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
  document.getElementById('app').classList.remove('oculto');
  document.getElementById('usuario-email').textContent = session.user.email;
  cargarVistaResumen();
  cargarSelectorEstudios();
  cargarLogCargas();
}

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

  const nacional = await consultarPaginado(() => supabaseClient
    .from('matriz_mensual')
    .select('mes, valor')
    .eq('parametro', 'RECUPERO')
    .order('mes', { ascending: true })
  );
  const nacionalFichas = await consultarPaginado(() => supabaseClient
    .from('matriz_mensual')
    .select('mes, valor')
    .eq('parametro', 'CAUSAS CON PAGOS')
    .order('mes', { ascending: true })
  );

  // ---- KPIs ----
  const suma = (param) => base.filter(f => f.parametro === param).reduce((acc, f) => acc + Number(f.valor), 0);
  const ultimoMesNacional = nacionalFichas.length ? nacionalFichas[nacionalFichas.length - 1].mes : null;
  const fichasUltimoMes = nacionalFichas.filter(f => f.mes === ultimoMesNacional).reduce((a, f) => a + Number(f.valor), 0);
  const kpis = [
    { etiqueta: 'Recupero últ. mes (nacional)', valor: formateadorMoneda.format(suma('RECUPERO ULT.MES CERRADO')) },
    { etiqueta: 'Fichas con pago (últ. mes)', valor: formateadorNumero.format(fichasUltimoMes) },
    { etiqueta: 'Causas en gestión', valor: formateadorNumero.format(suma('EN GESTIÓN')) },
    { etiqueta: 'Causas iniciadas', valor: formateadorNumero.format(suma('INICIADAS')) },
    { etiqueta: 'Con embargo de haberes', valor: formateadorNumero.format(suma('CON EMBARGO HABERES')) },
  ];
  document.getElementById('kpis-generales').innerHTML = kpis.map(k => `
    <div class="tarjeta-kpi">
      <span class="valor">${k.valor}</span>
      <span class="etiqueta">${k.etiqueta}</span>
    </div>`).join('');

  const ultimaActualizacion = base.reduce((max, f) => f.actualizado_en > max ? f.actualizado_en : max, '');
  document.getElementById('resumen-actualizado').textContent = ultimaActualizacion
    ? `Actualizado: ${new Date(ultimaActualizacion).toLocaleString('es-AR')}`
    : '';

  // ---- Gráfico: recupero mensual nacional (suma de todos los estudios por mes) ----
  const porMes = {};
  nacional.forEach(f => { porMes[f.mes] = (porMes[f.mes] || 0) + Number(f.valor); });
  const porMesFichas = {};
  nacionalFichas.forEach(f => { porMesFichas[f.mes] = (porMesFichas[f.mes] || 0) + Number(f.valor); });
  const meses = Object.keys(porMes).sort();
  dibujarLineaConFichas('grafico-recupero-nacional', meses,
    [{ etiqueta: 'Recupero total', datos: meses.map(m => porMes[m]), color: COLOR_BRONCE }],
    meses.map(m => porMesFichas[m] || 0));

  cargarSeguimiento('nacional', granularidadNacional);

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

async function cargarVistaEstudio(estudioId) {
  const filas = await consultarPaginado(() => supabaseClient
    .from('matriz_mensual')
    .select('mes, parametro, valor')
    .eq('estudio_id', estudioId)
    .order('mes', { ascending: true })
  );
  if (!filas) return;

  const meses = [...new Set(filas.map(f => f.mes))].sort();
  const porParametro = (param) => meses.map(m => Number((filas.find(f => f.mes === m && f.parametro === param) || {}).valor || 0));

  dibujarLineaConFichas('grafico-estudio-recupero', meses,
    [
      { etiqueta: 'Total', datos: porParametro('RECUPERO'), color: COLOR_BRONCE },
      { etiqueta: 'Judicial', datos: porParametro('RECUPERO JUDICIAL'), color: COLOR_TINTA },
      { etiqueta: 'Extrajudicial', datos: porParametro('RECUPERO EXTRA'), color: COLOR_VERDE },
    ],
    porParametro('CAUSAS CON PAGOS'));

  const ultimoMes = meses[meses.length - 1];
  const valorEn = (param) => Number((filas.find(f => f.mes === ultimoMes && f.parametro === param) || {}).valor || 0);
  dibujarBarras('grafico-estudio-companias', ['CFN', 'Megatone', 'Confina'],
    [valorEn('RECUPERO CFN'), valorEn('RECUPERO EM'), valorEn('RECUPERO CONFINA')], COLOR_BRONCE);

  dibujarBarras('grafico-estudio-pasos', meses, porParametro('CANT. DE SENTENCIAS FIRMES'), COLOR_TINTA,
    { etiqueta2: 'Liquidaciones', datos2: porParametro('CANT. DE LIQUIDACIONES'), color2: COLOR_VERDE });

  dibujarBarras('grafico-estudio-embargos', meses, porParametro('NUEVOS EMBARGOS'), COLOR_BRONCE);

  estudioSeleccionadoActual = estudioId;
  cargarSeguimiento('estudio', granularidadEstudio, estudioId);
}

// ============================================================
// SEGUIMIENTO DIARIO/SEMANAL DEL RECUPERO
// ============================================================
let granularidadNacional = 'diario';
let granularidadEstudio = 'diario';
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
  const idCanvas = objetivo === 'nacional' ? 'grafico-seguimiento-nacional' : 'grafico-seguimiento-estudio';

  const construirConsulta = () => {
    let q = supabaseClient.from('recupero_diario').select('fecha, valor').order('fecha', { ascending: true });
    if (objetivo === 'estudio' && estudioId) q = q.eq('estudio_id', estudioId);
    return q;
  };
  const filas = await consultarPaginado(construirConsulta);

  const agrupado = {};
  filas.forEach(f => {
    const clave = granularidad === 'semanal' ? claveDeSemana(f.fecha) : f.fecha;
    agrupado[clave] = (agrupado[clave] || 0) + Number(f.valor);
  });
  const claves = Object.keys(agrupado).sort();
  const etiquetaSerie = granularidad === 'semanal' ? 'Recupero (semana del)' : 'Recupero diario';
  dibujarLinea(idCanvas, claves, [{ etiqueta: etiquetaSerie, datos: claves.map(c => agrupado[c]), color: COLOR_BRONCE }]);
}

document.querySelectorAll('.selector-granularidad').forEach(selector => {
  selector.addEventListener('click', (e) => {
    const boton = e.target.closest('.chip-granularidad');
    if (!boton) return;
    selector.querySelectorAll('.chip-granularidad').forEach(b => b.classList.remove('activa'));
    boton.classList.add('activa');
    const objetivo = selector.dataset.objetivo;
    const granularidad = boton.dataset.granularidad;
    if (objetivo === 'nacional') {
      granularidadNacional = granularidad;
      cargarSeguimiento('nacional', granularidadNacional);
    } else {
      granularidadEstudio = granularidad;
      cargarSeguimiento('estudio', granularidadEstudio, estudioSeleccionadoActual);
    }
  });
});

// ============================================================
// VISTA: CARGAR DATOS
// ============================================================
document.getElementById('form-carga').addEventListener('submit', async (e) => {
  e.preventDefault();
  const estadoEl = document.getElementById('carga-estado');
  const boton = document.getElementById('btn-cargar');
  estadoEl.textContent = 'Subiendo los archivos… con archivos grandes puede tardar varios minutos, no cierres esta pestaña.';
  estadoEl.className = 'mensaje-estado';
  boton.disabled = true;

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

    // La respuesta llega apenas el servidor RECIBE los archivos — el cálculo
    // pesado sigue corriendo después, en el servidor. Por eso no mostramos
    // un resultado final acá, sino que avisamos dónde chequear el progreso.
    estadoEl.textContent = resultado.mensaje || 'Archivos recibidos, procesando en el servidor...';
    estadoEl.className = 'mensaje-estado ok';
    cargarLogCargas();
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

    estadoEl.textContent = resultado.mensaje || 'Archivos recibidos, procesando en el servidor...';
    estadoEl.className = 'mensaje-estado ok';
    cargarLogCargas();
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

iniciarApp();
