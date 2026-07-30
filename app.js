const supabaseClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

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

  const { data: nacional, error: errNac } = await supabaseClient
    .from('matriz_mensual')
    .select('mes, valor')
    .eq('parametro', 'RECUPERO')
    .order('mes', { ascending: true });
  if (errNac) { console.error(errNac); return; }

  // ---- KPIs ----
  const suma = (param) => base.filter(f => f.parametro === param).reduce((acc, f) => acc + Number(f.valor), 0);
  const kpis = [
    { etiqueta: 'Recupero últ. mes (nacional)', valor: formateadorMoneda.format(suma('RECUPERO ULT.MES CERRADO')) },
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
  const meses = Object.keys(porMes).sort();
  dibujarLinea('grafico-recupero-nacional', meses, [
    { etiqueta: 'Recupero total', datos: meses.map(m => porMes[m]), color: COLOR_BRONCE },
  ]);

  // ---- Gráfico: barras por estudio (últ. mes cerrado) ----
  const filasUltimoMes = base.filter(f => f.parametro === 'RECUPERO ULT.MES CERRADO' && Number(f.valor) > 0)
    .sort((a, b) => b.valor - a.valor);
  dibujarBarras('grafico-barras-estudios',
    filasUltimoMes.map(f => f.estudios.nombre),
    filasUltimoMes.map(f => Number(f.valor)),
    COLOR_TINTA);

  // ---- Gráfico: torta judicial vs extrajudicial (último mes, todos los estudios) ----
  const { data: judExtra } = await supabaseClient
    .from('matriz_mensual')
    .select('parametro, valor, mes')
    .in('parametro', ['RECUPERO JUDICIAL', 'RECUPERO EXTRA'])
    .eq('mes', meses[meses.length - 1]);
  const totalJud = (judExtra || []).filter(f => f.parametro === 'RECUPERO JUDICIAL').reduce((a, f) => a + Number(f.valor), 0);
  const totalExtra = (judExtra || []).filter(f => f.parametro === 'RECUPERO EXTRA').reduce((a, f) => a + Number(f.valor), 0);
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
  const { data: filas } = await supabaseClient
    .from('matriz_mensual')
    .select('mes, parametro, valor')
    .eq('estudio_id', estudioId)
    .order('mes', { ascending: true });
  if (!filas) return;

  const meses = [...new Set(filas.map(f => f.mes))].sort();
  const porParametro = (param) => meses.map(m => Number((filas.find(f => f.mes === m && f.parametro === param) || {}).valor || 0));

  dibujarLinea('grafico-estudio-recupero', meses, [
    { etiqueta: 'Total', datos: porParametro('RECUPERO'), color: COLOR_BRONCE },
    { etiqueta: 'Judicial', datos: porParametro('RECUPERO JUDICIAL'), color: COLOR_TINTA },
    { etiqueta: 'Extrajudicial', datos: porParametro('RECUPERO EXTRA'), color: COLOR_VERDE },
  ]);

  const ultimoMes = meses[meses.length - 1];
  const valorEn = (param) => Number((filas.find(f => f.mes === ultimoMes && f.parametro === param) || {}).valor || 0);
  dibujarBarras('grafico-estudio-companias', ['CFN', 'Megatone', 'Confina'],
    [valorEn('RECUPERO CFN'), valorEn('RECUPERO EM'), valorEn('RECUPERO CONFINA')], COLOR_BRONCE);

  dibujarBarras('grafico-estudio-pasos', meses, porParametro('CANT. DE SENTENCIAS FIRMES'), COLOR_TINTA,
    { etiqueta2: 'Liquidaciones', datos2: porParametro('CANT. DE LIQUIDACIONES'), color2: COLOR_VERDE });
}

// ============================================================
// VISTA: CARGAR DATOS
// ============================================================
document.getElementById('form-carga').addEventListener('submit', async (e) => {
  e.preventDefault();
  const estadoEl = document.getElementById('carga-estado');
  const boton = document.getElementById('btn-cargar');
  estadoEl.textContent = 'Procesando… esto puede tardar hasta 1 minuto (el servidor gratuito arranca en frío).';
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

    estadoEl.textContent = `Listo: ${resultado.filas_matriz_mensual} filas mensuales y ${resultado.filas_base_gral} filas de resumen actualizadas.`;
    estadoEl.className = 'mensaje-estado ok';
    cargarVistaResumen();
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
  document.querySelector('#tabla-log tbody').innerHTML = (log || []).map(f => `
    <tr>
      <td>${new Date(f.subido_en).toLocaleString('es-AR')}</td>
      <td>${f.subido_por || ''}</td>
      <td>${f.estado}</td>
      <td>${f.mensaje || ''}</td>
    </tr>`).join('');
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

iniciarApp();
