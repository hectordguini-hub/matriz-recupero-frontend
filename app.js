const supabaseClient = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const formateadorNumero = new Intl.NumberFormat('es-AR');
const formateadorPorcentaje = new Intl.NumberFormat('es-AR', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });

const COLOR_TINTA = '#25404a';
const COLOR_BRONCE = '#ca0130';
const COLOR_VERDE = '#3f6b4f';
const COLOR_ROJO = '#a23b2d';
const graficos = {};

function destruirSiExiste(id) {
  if (graficos[id]) { graficos[id].destroy(); delete graficos[id]; }
}

// ============================================================
// LOGIN / SESIÓN
// ============================================================
// Si la sesion vencio (o se cerro en otra pestaña), getSession() devuelve
// null y antes se mostraba un error tecnico. Ahora se explica que hacer.
function tokenSesion(session) {
  if (!session || !session.access_token) {
    throw new Error('Tu sesión venció. Hacé clic en "Salir", volvé a ingresar con tu usuario y repetí la carga.');
  }
  return session.access_token;
}

supabaseClient.auth.getSession().then(({ data: { session } }) => {
  if (session) mostrarApp(session);
});

document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) { errorEl.textContent = 'Email o contraseña incorrectos.'; return; }
  mostrarApp(data.session);
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await supabaseClient.auth.signOut();
  location.reload();
});

async function mostrarApp(session) {
  document.getElementById('pantalla-login').classList.add('oculto');
  document.getElementById('app').classList.remove('oculto');
  document.getElementById('usuario-email').textContent = session.user.email;
  await cargarSelectorUnidadNegocio();
  await Promise.all([
    llenarSelectorUnidadSimple('pv-unidad-negocio'),
    llenarSelectorUnidadSimple('conv-unidad-negocio'),
    llenarSelectorUnidadSimple('nc-unidad-negocio'),
    llenarSelectorUnidadSimple('sg-unidad-negocio'),
  ]);
  await aplicarRestriccionUnidad(session.user.email);
  cargarVistaResumen();
  cargarLogCargas();
}

async function cargarSelectorUnidadNegocio() {
  const { data } = await supabaseClient.rpc('unidades_negocio_disponibles');
  const selects = [document.getElementById('selector-unidad-resumen'), document.getElementById('cartera-resumen-unidad')];
  (data || []).forEach(f => {
    selects.forEach((select, i) => {
      const opt = document.createElement('option');
      opt.value = f.unidad_negocio;
      opt.textContent = f.unidad_negocio;
      select.appendChild(opt);
    });
  });
}

// ============================================================
// RESTRICCION DE UNIDAD PARA REFERENTES
// ============================================================
async function aplicarRestriccionUnidad(email) {
  const { data } = await supabaseClient
    .from('referentes_unidad')
    .select('unidad_negocio')
    .eq('email', email);

  // Si el email no esta en la tabla (por ejemplo la cuenta de
  // administracion), no se restringe nada -> sigue viendo todo.
  if (!data || data.length === 0) return;

  // Un referente (cualquiera con restriccion) no puede crear usuarios
  // nuevos -> se le oculta el formulario, no solo se le bloquea en el
  // backend.
  const formAltaUsuario = document.getElementById('form-alta-usuario');
  if (formAltaUsuario) formAltaUsuario.classList.add('oculto');

  const unidadesPermitidas = data.map(f => f.unidad_negocio);
  const todosLosSelectores = [
    'selector-unidad-resumen', 'cartera-resumen-unidad', 'comp-unidad-negocio', 'rd-unidad-negocio',
    'cartera-unidad-negocio', 'recupero-unidad-negocio', 'baja-unidad-negocio',
    'pv-unidad-negocio', 'conv-unidad-negocio', 'nc-unidad-negocio', 'sg-unidad-negocio', 'masivos-unidad-negocio',
  ];

  todosLosSelectores.forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;
    Array.from(select.options).forEach(opt => {
      // Se conserva la opcion vacia/placeholder ("", o el "Todas" en los
      // selectores que la tienen) solo si el select NO es de los que
      // muestran "Todas" -> en los que si la tienen, "Todas" se saca
      // igual, porque un referente no deberia poder ver el conjunto.
      if (opt.value === '') { select.removeChild(opt); return; }
      if (opt.value === 'JUDICIAL_AUTO') { select.removeChild(opt); return; }
      if (!unidadesPermitidas.includes(opt.value)) select.removeChild(opt);
    });
    if (select.options.length > 0) {
      select.value = select.options[0].value;
      select.dispatchEvent(new Event('change'));
    }
    if (select.options.length === 1) select.disabled = true;
  });
}

// ============================================================
// VISTA: CARTERA (composicion y resumen)
// ============================================================
document.getElementById('cartera-resumen-unidad').addEventListener('change', cargarVistaCarteraResumen);
document.getElementById('cartera-resumen-incluir-pagos').addEventListener('change', cargarVistaCarteraResumen);

async function cargarVistaCarteraResumen() {
  const unidad = document.getElementById('cartera-resumen-unidad').value;
  if (!unidad) return;
  const incluirPagos = document.getElementById('cartera-resumen-incluir-pagos').checked;

  const [totalesResp, porBoxResp, porRangoResp] = await Promise.all([
    supabaseClient.rpc('cartera_totales', { p_unidad_negocio: unidad, p_incluir_pagos_vigentes: incluirPagos }),
    supabaseClient.rpc('cartera_resumen_por_box', { p_unidad_negocio: unidad, p_incluir_pagos_vigentes: incluirPagos }),
    supabaseClient.rpc('cartera_resumen_por_rango', { p_unidad_negocio: unidad, p_incluir_pagos_vigentes: incluirPagos }),
  ]);

  const totales = (totalesResp.data && totalesResp.data[0]) || {};
  const formateadorMoneda = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

  document.getElementById('cartera-resumen-totales').innerHTML = [
    { etiqueta: 'Créditos/Fichas totales', valor: formateadorNumero.format(totales.creditos || 0) },
    { etiqueta: 'DNI totales (sin duplicar)', valor: formateadorNumero.format(totales.dni || 0) },
    { etiqueta: 'Saldo total', valor: formateadorMoneda.format(totales.saldo || 0) },
  ].map(k => `<div class="tarjeta-kpi"><span class="valor">${k.valor}</span><span class="etiqueta">${k.etiqueta}</span></div>`).join('');

  const filaHtml = f => `
    <tr>
      <td>${f.box || f.rango}</td>
      <td class="numero">${formateadorNumero.format(f.creditos)}</td>
      <td class="numero">${formateadorNumero.format(f.dni)}</td>
      <td class="numero">${formateadorMoneda.format(f.saldo)}</td>
      <td class="numero">${formateadorPorcentaje.format(f.pct_creditos)}</td>
      <td class="numero">${formateadorPorcentaje.format(f.pct_dni)}</td>
      <td class="numero">${formateadorPorcentaje.format(f.pct_saldo)}</td>
    </tr>`;

  const filaTotalHtml = filas => {
    if (!filas.length) return '';
    const sum = campo => filas.reduce((acc, f) => acc + Number(f[campo] || 0), 0);
    return `
      <tr class="fila-mes-actual">
        <td><strong>Total</strong></td>
        <td class="numero"><strong>${formateadorNumero.format(sum('creditos'))}</strong></td>
        <td class="numero"><strong>${formateadorNumero.format(sum('dni'))}</strong></td>
        <td class="numero"><strong>${formateadorMoneda.format(sum('saldo'))}</strong></td>
        <td class="numero"><strong>${formateadorPorcentaje.format(sum('pct_creditos'))}</strong></td>
        <td class="numero"><strong>${formateadorPorcentaje.format(sum('pct_dni'))}</strong></td>
        <td class="numero"><strong>${formateadorPorcentaje.format(sum('pct_saldo'))}</strong></td>
      </tr>`;
  };

  const filasBox = porBoxResp.data || [];
  const filasRango = porRangoResp.data || [];
  document.querySelector('#tabla-cartera-por-box tbody').innerHTML = filasBox.map(filaHtml).join('') + filaTotalHtml(filasBox);
  document.querySelector('#tabla-cartera-por-rango tbody').innerHTML = filasRango.map(filaHtml).join('') + filaTotalHtml(filasRango);
}

document.getElementById('btn-descargar-cartera').addEventListener('click', async () => {
  const unidad = document.getElementById('cartera-resumen-unidad').value;
  const estadoEl = document.getElementById('cartera-descarga-estado');
  if (!unidad) {
    estadoEl.textContent = 'Elegí una unidad de negocio primero.';
    estadoEl.className = 'mensaje-estado error';
    return;
  }
  const boton = document.getElementById('btn-descargar-cartera');
  boton.disabled = true;
  estadoEl.className = 'mensaje-estado';

  try {
    // Se pagina de a 1000 filas (limite de Supabase por consulta) hasta
    // traer toda la cartera de la unidad, que en algunas unidades supera
    // las 50.000 fichas.
    const filas = [];
    const tamanoPagina = 1000;
    let desde = 0;
    while (true) {
      estadoEl.textContent = `Descargando… ${filas.length} fichas traídas`;
      const { data, error } = await supabaseClient
        .from('cartera_asignada')
        .select('compania, ficha, box, nro_documento, nombre_causa, deuda_total, fecha_inicio_estudio, provincia, rango, estado, telefono_1, telefono_2, telefono_3, email')
        .eq('unidad_negocio', unidad)
        .order('id', { ascending: true })
        .range(desde, desde + tamanoPagina - 1);
      if (error) throw new Error(error.message);
      filas.push(...data);
      if (data.length < tamanoPagina) break;
      desde += tamanoPagina;
    }

    if (filas.length === 0) {
      estadoEl.textContent = 'No hay fichas cargadas todavía para esta unidad.';
      estadoEl.className = 'mensaje-estado error';
      return;
    }

    const hoja = XLSX.utils.json_to_sheet(filas);
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, unidad.slice(0, 31));
    const nombreArchivo = `Cartera_${unidad.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(libro, nombreArchivo);

    estadoEl.textContent = `Listo — ${filas.length} fichas descargadas.`;
    estadoEl.className = 'mensaje-estado ok';
  } catch (err) {
    estadoEl.textContent = `Error: ${err.message}`;
    estadoEl.className = 'mensaje-estado error';
  } finally {
    boton.disabled = false;
  }
});

// ============================================================
// NAVEGACIÓN
// ============================================================
document.getElementById('nav-pestanas').addEventListener('click', (e) => {
  const boton = e.target.closest('.pestana');
  if (!boton) return;
  document.querySelectorAll('.pestana').forEach(b => b.classList.remove('activa'));
  boton.classList.add('activa');
  document.querySelectorAll('.vista').forEach(v => v.classList.add('oculto'));
  document.getElementById(`vista-${boton.dataset.vista}`).classList.remove('oculto');
  document.getElementById('nav-pestanas').classList.add('oculto-menu');
});

document.getElementById('btn-toggle-menu').addEventListener('click', () => {
  document.getElementById('nav-pestanas').classList.toggle('oculto-menu');
});

// ============================================================
// VISTA: RESUMEN
// ============================================================
function llenarSelectorMeses() {
  const select = document.getElementById('selector-rango-resumen');
  const hoy = new Date();
  const nombresMes = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  for (let i = 0; i < 6; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    const valor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const opt = document.createElement('option');
    opt.value = valor;
    opt.textContent = i === 0 ? `${nombresMes[d.getMonth()]} ${d.getFullYear()} (actual)` : `${nombresMes[d.getMonth()]} ${d.getFullYear()}`;
    if (i === 0) opt.selected = true;
    select.appendChild(opt);
  }
}
llenarSelectorMeses();

function fechasDelMesSeleccionado() {
  const [anio, mes] = document.getElementById('selector-rango-resumen').value.split('-').map(Number);
  const hoy = new Date();
  const esMesActual = (anio === hoy.getFullYear() && mes === hoy.getMonth() + 1);
  const desde = new Date(anio, mes - 1, 1);
  // Si es el mes en curso, corta hoy; si es un mes anterior, va hasta el ultimo dia de ese mes.
  const hasta = esMesActual ? hoy : new Date(anio, mes, 0);
  const aISO = f => f.toISOString().slice(0, 10);
  return { fechaDesde: aISO(desde), fechaHasta: aISO(hasta) };
}

// Dias habiles: Lunes a Sabado cuentan como dia entero; Domingo no.
function calcularDiasHabiles() {
  const [anio, mes] = document.getElementById('selector-rango-resumen').value.split('-').map(Number);
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const ultimoDia = new Date(anio, mes, 0).getDate();
  let totalMes = 0, restantes = 0;
  for (let d = 1; d <= ultimoDia; d++) {
    const fecha = new Date(anio, mes - 1, d);
    if (fecha.getDay() === 0) continue; // domingo no es habil
    totalMes++;
    if (fecha >= hoy) restantes++;
  }
  return { totalMes, restantes };
}

document.getElementById('selector-rango-resumen').addEventListener('change', cargarVistaResumen);
document.getElementById('selector-unidad-resumen').addEventListener('change', () => {
  actualizarVisibilidadEmpresa();
  cargarVistaResumen();
});
document.getElementById('selector-empresa-resumen').addEventListener('change', cargarVistaResumen);

// El selector de empresa solo aplica a GERENCIAR RECUPERA, que maneja
// ambas empresas juntas. En cualquier otra unidad se oculta y se ignora.
function esUnidadMultiempresa() {
  return (document.getElementById('selector-unidad-resumen').value || '').toUpperCase() === 'GERENCIAR RECUPERA';
}
function actualizarVisibilidadEmpresa() {
  const fila = document.getElementById('fila-empresa-resumen');
  const sel = document.getElementById('selector-empresa-resumen');
  if (esUnidadMultiempresa()) fila.classList.remove('oculto');
  else { fila.classList.add('oculto'); sel.value = ''; }
}
function empresaSeleccionada() {
  return esUnidadMultiempresa() ? (document.getElementById('selector-empresa-resumen').value || null) : null;
}

async function cargarVistaResumen() {
  const { fechaDesde, fechaHasta } = fechasDelMesSeleccionado();
  const unidadNegocio = document.getElementById('selector-unidad-resumen').value || null;
  actualizarVisibilidadEmpresa();
  const empresa = empresaSeleccionada();

  const [kpisResp, porAgenteDiaResp, efectividadResp, porCanalResp, porEfectoResp, extendidoResp, masividadResp, carteraDniResp, objetivoFijoResp] = await Promise.all([
    supabaseClient.rpc('gestiones_kpis', { fecha_desde: fechaDesde, fecha_hasta: fechaHasta, p_unidad_negocio: unidadNegocio, p_empresa: empresa }),
    supabaseClient.rpc('gestiones_por_agente_dia', { fecha_desde: fechaDesde, fecha_hasta: fechaHasta, p_unidad_negocio: unidadNegocio, p_empresa: empresa }),
    supabaseClient.rpc('gestiones_efectividad_por_agente', { fecha_desde: fechaDesde, fecha_hasta: fechaHasta, p_unidad_negocio: unidadNegocio, p_empresa: empresa }),
    supabaseClient.rpc('gestiones_por_canal', { fecha_desde: fechaDesde, fecha_hasta: fechaHasta, p_unidad_negocio: unidadNegocio, p_empresa: empresa }),
    supabaseClient.rpc('gestiones_por_efecto', { fecha_desde: fechaDesde, fecha_hasta: fechaHasta, p_unidad_negocio: unidadNegocio, p_empresa: empresa }),
    supabaseClient.rpc('gestiones_extendido_por_agente', { fecha_desde: fechaDesde, fecha_hasta: fechaHasta, p_unidad_negocio: unidadNegocio, p_empresa: empresa }),
    supabaseClient.rpc('gestiones_masividad', { fecha_desde: fechaDesde, fecha_hasta: fechaHasta, p_unidad_negocio: unidadNegocio, p_empresa: empresa }),
    unidadNegocio
      ? supabaseClient.rpc('cartera_embudo_efectividad', { p_unidad_negocio: unidadNegocio, fecha_desde: fechaDesde, fecha_hasta: fechaHasta, p_empresa: empresaSeleccionada() })
      : Promise.resolve({ data: null }),
    // Objetivo "congelado": la deuda total de la cartera tal como quedó
    // registrada la última vez que se cargó una cartera completa para esta
    // unidad — no se mueve con las bajas posteriores, porque el cliente
    // mide el objetivo sobre lo que nos asignó originalmente.
    unidadNegocio
      ? supabaseClient.rpc('cartera_objetivo_congelado', { p_unidad_negocio: unidadNegocio })
      : Promise.resolve({ data: null }),
  ]);

  const extendidoPorUsuario = {};
  (extendidoResp.data || []).forEach(f => { extendidoPorUsuario[`${f.usuario}|${f.empresa || ''}`] = f; });

  const kpis = (kpisResp.data && kpisResp.data[0]) || {};
  const porAgenteDia = porAgenteDiaResp.data || [];
  const efectividad = efectividadResp.data || [];
  const porCanal = porCanalResp.data || [];
  const porEfecto = porEfectoResp.data || [];
  const dniCarteraAsignada = carteraDniResp.data && carteraDniResp.data[0] ? carteraDniResp.data[0].dni_cartera : null;
  const embudoParaKpi = (carteraDniResp.data && carteraDniResp.data[0]) || null;

  // ---- KPIs ----
  // % Efectividad = contacto directo (por ultima gestion de cada DNI)
  // sobre la cantidad de DNI trabajados (tambien deduplicado) — no sobre
  // el total de filas de gestion, que puede tener varios intentos sobre
  // el mismo DNI.
  const pctEfectividad = kpis.dni_trabajados ? (Number(kpis.contacto_directo || 0) / Number(kpis.dni_trabajados)) : 0;
  const masividad = (masividadResp.data && masividadResp.data[0]) || {};
  const formateadorMonedaMasividad = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  const diasHabiles = calcularDiasHabiles();
  const kpisHtml = [
    { etiqueta: 'Total gestiones', valor: formateadorNumero.format(kpis.total_gestiones || 0) },
    { etiqueta: 'DNI trabajados', valor: formateadorNumero.format(kpis.dni_trabajados || 0) },
    { etiqueta: 'Cartera Asignada (DNI)', valor: dniCarteraAsignada !== null ? formateadorNumero.format(dniCarteraAsignada) : '—' },
    { etiqueta: 'Días hábiles restantes', valor: `${diasHabiles.restantes} / ${diasHabiles.totalMes}` },
    { etiqueta: 'Agentes activos', valor: formateadorNumero.format(kpis.agentes_activos || 0) },
    { etiqueta: 'Contacto directo', valor: formateadorNumero.format(kpis.contacto_directo || 0) },
    { etiqueta: '% Efectividad (contacto directo)', valor: formateadorPorcentaje.format(pctEfectividad) },
    { etiqueta: 'Pagos por mensajes masivos', valor: `${formateadorNumero.format(masividad.dni_con_pago || 0)} (${formateadorMonedaMasividad.format(masividad.monto_recaudado || 0)})` },
  ];
  if (embudoParaKpi) {
    const objetivo = objetivoRecaudacion(unidadNegocio);
    // Base del objetivo: la deuda "congelada" al momento de la última
    // carga de cartera completa, si ya existe esa foto; si todavía no se
    // cargó ninguna cartera para esta unidad desde que existe esta foto,
    // se usa la deuda en vivo como respaldo.
    const objetivoFijo = (objetivoFijoResp.data && objetivoFijoResp.data[0]) || null;
    const deudaBaseObjetivo = (objetivoFijo && !empresa) ? Number(objetivoFijo.deuda_total_congelada) : (embudoParaKpi.deuda_cartera || 0);
    const metaEnPesos = deudaBaseObjetivo * objetivo;
    const recaudado = embudoParaKpi.recaudacion || 0;
    // Ratio = recaudado a la fecha / total de cartera asignada (congelado)
    // — no contra el objetivo del 2%/1,5%. Se recalcula solo, día a día,
    // a medida que se cargan pagos (el denominador no se mueve hasta la
    // próxima carga completa de cartera).
    const ratio = deudaBaseObjetivo ? recaudado / deudaBaseObjetivo : 0;
    kpisHtml.push({
      etiqueta: `Objetivo (${formateadorPorcentaje.format(objetivo)} de la cartera asignada)`,
      valor: formateadorMonedaMasividad.format(metaEnPesos),
    });
    kpisHtml.push({
      etiqueta: 'Recaudado',
      valor: formateadorMonedaMasividad.format(recaudado),
    });
    kpisHtml.push({
      etiqueta: `Ratio (sobre total asignado: ${formateadorMonedaMasividad.format(deudaBaseObjetivo)})`,
      valor: formateadorPorcentaje.format(ratio),
    });
  }
  document.getElementById('kpis-resumen').innerHTML = kpisHtml.map(k => `
    <div class="tarjeta-kpi"><span class="valor">${k.valor}</span><span class="etiqueta">${k.etiqueta}</span></div>`).join('');

  // ---- Gráfico: volumen por día (sumando todos los agentes/empresas) ----
  const volumenPorDia = {};
  porAgenteDia.forEach(f => { volumenPorDia[f.fecha] = (volumenPorDia[f.fecha] || 0) + Number(f.cantidad); });
  const diasOrdenados = Object.keys(volumenPorDia).sort();
  destruirSiExiste('grafico-volumen-dia');
  graficos['grafico-volumen-dia'] = new Chart(document.getElementById('grafico-volumen-dia'), {
    type: 'line',
    data: { labels: diasOrdenados, datasets: [{ label: 'Gestiones', data: diasOrdenados.map(d => volumenPorDia[d]), borderColor: COLOR_BRONCE, backgroundColor: COLOR_BRONCE + '22', tension: 0.25 }] },
    options: { responsive: true, plugins: { legend: { display: false } } },
  });

  // ---- Gráfico: efectividad total (torta) ----
  const totalesPorTipo = { 'CONTACTO DIRECTO': 0, 'CONTACTO INDIRECTO': 0, 'NO CONTACTO': 0 };
  efectividad.forEach(f => { if (f.tipo_contacto in totalesPorTipo) totalesPorTipo[f.tipo_contacto] += Number(f.cantidad); });
  destruirSiExiste('grafico-efectividad-total');
  graficos['grafico-efectividad-total'] = new Chart(document.getElementById('grafico-efectividad-total'), {
    type: 'doughnut',
    data: {
      labels: ['Contacto directo', 'Contacto indirecto', 'Sin contacto'],
      datasets: [{ data: Object.values(totalesPorTipo), backgroundColor: [COLOR_VERDE, COLOR_TINTA, COLOR_ROJO] }],
    },
    options: { responsive: true },
  });

  // ---- Gráfico: por canal (tipo de acción) ----
  const totalPorCanal = {};
  porCanal.forEach(f => { totalPorCanal[f.tipo_accion] = (totalPorCanal[f.tipo_accion] || 0) + Number(f.cantidad); });
  const canales = Object.keys(totalPorCanal);
  destruirSiExiste('grafico-por-canal');
  graficos['grafico-por-canal'] = new Chart(document.getElementById('grafico-por-canal'), {
    type: 'doughnut',
    data: { labels: canales, datasets: [{ data: canales.map(c => totalPorCanal[c]), backgroundColor: [COLOR_TINTA, COLOR_BRONCE, COLOR_VERDE, COLOR_ROJO, '#c9820a'] }] },
    options: { responsive: true },
  });

  // ---- Gráfico: por efecto (resultado de la gestión) ----
  const top15Efectos = porEfecto.slice(0, 15);
  destruirSiExiste('grafico-por-efecto');
  graficos['grafico-por-efecto'] = new Chart(document.getElementById('grafico-por-efecto'), {
    type: 'bar',
    data: { labels: top15Efectos.map(f => f.efecto), datasets: [{ label: 'Cantidad', data: top15Efectos.map(f => Number(f.cantidad)), backgroundColor: COLOR_TINTA }] },
    options: { responsive: true, plugins: { legend: { display: false } }, indexAxis: 'y' },
  });

  // ---- Tabla por agente ----
  const porAgente = {};
  porAgenteDia.forEach(f => {
    const clave = `${f.usuario}|${f.empresa || ''}`;
    if (!porAgente[clave]) porAgente[clave] = { usuario: f.usuario, empresa: f.empresa, gestiones: 0, directo: 0, indirecto: 0, sinContacto: 0, dniTrabajados: 0 };
    porAgente[clave].gestiones += Number(f.cantidad);
  });
  efectividad.forEach(f => {
    const clave = `${f.usuario}|${f.empresa || ''}`;
    if (!porAgente[clave]) porAgente[clave] = { usuario: f.usuario, empresa: f.empresa, gestiones: 0, directo: 0, indirecto: 0, sinContacto: 0, dniTrabajados: 0 };
    // 'efectividad' ahora viene deduplicada por DNI (ultima gestion), y
    // 'MASIVO SIN PAGO' es una 4ta categoria que solo cuenta para el
    // denominador del % (no se muestra como columna aparte).
    porAgente[clave].dniTrabajados += Number(f.cantidad);
    if (f.tipo_contacto === 'CONTACTO DIRECTO') porAgente[clave].directo += Number(f.cantidad);
    else if (f.tipo_contacto === 'CONTACTO INDIRECTO') porAgente[clave].indirecto += Number(f.cantidad);
    else if (f.tipo_contacto === 'NO CONTACTO') porAgente[clave].sinContacto += Number(f.cantidad);
  });
  const filasAgente = Object.values(porAgente).sort((a, b) => String(a.empresa || '').localeCompare(String(b.empresa || '')) || b.gestiones - a.gestiones);
  const formateadorMonedaRecupero = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  document.querySelector('#tabla-por-agente tbody').innerHTML = filasAgente.map(a => {
    // % Efectividad del agente = contacto directo (ultima gestion por DNI)
    // sobre el total de DNI que trabajo ese agente (incluye los DNI cuya
    // ultima gestion quedo excluida por masiva sin pago).
    const pct = a.dniTrabajados ? a.directo / a.dniTrabajados : 0;
    const ext = extendidoPorUsuario[`${a.usuario}|${a.empresa || ''}`] || { promesas: 0, promesas_cumplidas: 0, recupero_total: 0 };
    const pctCumplidas = ext.promesas ? ext.promesas_cumplidas / ext.promesas : 0;
    return `<tr>
      <td>${a.usuario}</td>
      <td>${a.empresa || ''}</td>
      <td class="numero">${formateadorNumero.format(a.gestiones)}</td>
      <td class="numero">${formateadorNumero.format(a.dniTrabajados)}</td>
      <td class="numero">${formateadorNumero.format(a.directo)}</td>
      <td class="numero">${formateadorNumero.format(a.indirecto)}</td>
      <td class="numero">${formateadorNumero.format(a.sinContacto)}</td>
      <td class="numero">${formateadorPorcentaje.format(pct)}</td>
      <td class="numero">${formateadorNumero.format(ext.promesas)}</td>
      <td class="numero">${formateadorNumero.format(ext.promesas_cumplidas)}</td>
      <td class="numero">${formateadorPorcentaje.format(pctCumplidas)}</td>
      <td class="numero">${formateadorMonedaRecupero.format(ext.recupero_total)}</td>
    </tr>`;
  }).join('');

  // ---- Fila de totales, sumando todas las filas de la tabla ----
  if (filasAgente.length) {
    const sumar = campo => filasAgente.reduce((acc, a) => acc + Number(a[campo] || 0), 0);
    const totGestiones = sumar('gestiones');
    const totDirecto = sumar('directo');
    const totIndirecto = sumar('indirecto');
    const totSinContacto = sumar('sinContacto');
    const totDniTrabajados = sumar('dniTrabajados');
    const totPromesas = filasAgente.reduce((acc, a) => acc + Number((extendidoPorUsuario[`${a.usuario}|${a.empresa || ''}`] || {}).promesas || 0), 0);
    const totCumplidas = filasAgente.reduce((acc, a) => acc + Number((extendidoPorUsuario[`${a.usuario}|${a.empresa || ''}`] || {}).promesas_cumplidas || 0), 0);
    const totRecupero = filasAgente.reduce((acc, a) => acc + Number((extendidoPorUsuario[`${a.usuario}|${a.empresa || ''}`] || {}).recupero_total || 0), 0);
    const pctTotal = totDniTrabajados ? totDirecto / totDniTrabajados : 0;
    const pctCumplidasTotal = totPromesas ? totCumplidas / totPromesas : 0;

    document.querySelector('#tabla-por-agente tbody').innerHTML += `
      <tr class="fila-mes-actual">
        <td colspan="2"><strong>Total</strong></td>
        <td class="numero"><strong>${formateadorNumero.format(totGestiones)}</strong></td>
        <td class="numero"><strong>${formateadorNumero.format(totDniTrabajados)}</strong></td>
        <td class="numero"><strong>${formateadorNumero.format(totDirecto)}</strong></td>
        <td class="numero"><strong>${formateadorNumero.format(totIndirecto)}</strong></td>
        <td class="numero"><strong>${formateadorNumero.format(totSinContacto)}</strong></td>
        <td class="numero"><strong>${formateadorPorcentaje.format(pctTotal)}</strong></td>
        <td class="numero"><strong>${formateadorNumero.format(totPromesas)}</strong></td>
        <td class="numero"><strong>${formateadorNumero.format(totCumplidas)}</strong></td>
        <td class="numero"><strong>${formateadorPorcentaje.format(pctCumplidasTotal)}</strong></td>
        <td class="numero"><strong>${formateadorMonedaRecupero.format(totRecupero)}</strong></td>
      </tr>`;
  }

  await cargarEmbudoYContactabilidad(unidadNegocio, fechaDesde, fechaHasta, carteraDniResp, pctEfectividad);
}

// ============================================================
// EMBUDO DE EFECTIVIDAD Y CONTACTABILIDAD DE LA CARTERA
// ============================================================
const OBJETIVOS_EMBUDO = { contacto: 0.20, promesas: 0.50, cumplidas: 0.60, recaudacion: 0.02 };
// ON CITY JUDICIAL, CFN JUDICIAL y GERENCIAR RECUPERA tienen una meta de
// recupero mas baja (1,5%) que el resto (2%, valor por defecto).
const UNIDADES_OBJETIVO_1_5 = ['ON CITY JUDICIAL', 'CFN JUDICIAL', 'GERENCIAR RECUPERA'];
function objetivoRecaudacion(unidadNegocio) {
  return UNIDADES_OBJETIVO_1_5.includes(unidadNegocio) ? 0.005 : OBJETIVOS_EMBUDO.recaudacion;
}

async function cargarEmbudoYContactabilidad(unidadNegocio, fechaDesde, fechaHasta, embudoRespPrevio, pctEfectividadKpi) {
  const mensajeSinUnidad = document.getElementById('embudo-mensaje-sin-unidad');
  const contenido = document.getElementById('embudo-contenido');
  const contactabilidadContenido = document.getElementById('contactabilidad-contenido');

  if (!unidadNegocio) {
    mensajeSinUnidad.classList.remove('oculto');
    contenido.classList.add('oculto');
    contactabilidadContenido.classList.add('oculto');
    return;
  }
  mensajeSinUnidad.classList.add('oculto');
  contenido.classList.remove('oculto');
  contactabilidadContenido.classList.remove('oculto');

  // El embudo ya se pidio en cargarVistaResumen (para el KPI de Cartera
  // Asignada) — se reutiliza esa respuesta en vez de pedirla de nuevo.
  const [embudoResp, contactabilidadResp] = await Promise.all([
    embudoRespPrevio || supabaseClient.rpc('cartera_embudo_efectividad', { p_unidad_negocio: unidadNegocio, fecha_desde: fechaDesde, fecha_hasta: fechaHasta, p_empresa: empresaSeleccionada() }),
    supabaseClient.rpc('cartera_contactabilidad', { p_unidad_negocio: unidadNegocio, fecha_desde: fechaDesde, fecha_hasta: fechaHasta, p_empresa: empresaSeleccionada() }),
  ]);

  const e = (embudoResp.data && embudoResp.data[0]) || {};
  const formateadorMoneda = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

  // % Real de "Contacto a Titular" = el mismo % Efectividad del KPI de
  // arriba (contacto directo sobre DNI trabajados) — no sobre el total
  // de la Cartera Asignada. La cantidad que se muestra sigue siendo la
  // del embudo (DNI de la cartera contactados a titular).
  const pctContacto = pctEfectividadKpi || 0;
  const pctPromesas = e.dni_contactados_titular ? e.dni_promesas / e.dni_contactados_titular : 0;
  const pctCumplidas = e.dni_promesas ? e.dni_promesas_cumplidas / e.dni_promesas : 0;
  const pctRecaudacion = e.deuda_cartera ? e.recaudacion / e.deuda_cartera : 0;

  const filaEmbudo = (etapa, cantidad, pct, objetivo, esMoneda) => {
    const desvio = pct - objetivo;
    const signo = desvio >= 0 ? '+' : '';
    const color = desvio >= 0 ? 'var(--verde-recupero)' : 'var(--rojo-alerta)';
    return `
    <tr>
      <td>${etapa}</td>
      <td class="numero">${esMoneda ? formateadorMoneda.format(cantidad) : formateadorNumero.format(cantidad)}</td>
      <td class="numero">${formateadorPorcentaje.format(pct)}</td>
      <td class="numero">${formateadorPorcentaje.format(objetivo)}</td>
      <td class="numero" style="color:${color}; font-weight:600;">${signo}${formateadorPorcentaje.format(desvio)}</td>
    </tr>`;
  };

  const filaSoloMonto = (etapa, cantidad) => `
    <tr>
      <td>${etapa}</td>
      <td class="numero">${formateadorMoneda.format(cantidad)}</td>
      <td class="numero">—</td>
      <td class="numero">—</td>
      <td class="numero">—</td>
    </tr>`;

  const esUnidadJudicial = unidadNegocio === 'ON CITY JUDICIAL' || unidadNegocio === 'CFN JUDICIAL';

  document.querySelector('#tabla-embudo tbody').innerHTML =
    `<tr><td><strong>Cartera Asignada (DNI)</strong></td><td class="numero"><strong>${formateadorNumero.format(e.dni_cartera || 0)}</strong></td><td class="numero">—</td><td class="numero">—</td><td class="numero">—</td></tr>` +
    filaEmbudo('Contacto a Titular', e.dni_contactados_titular || 0, pctContacto, OBJETIVOS_EMBUDO.contacto, false) +
    filaEmbudo('Promesas de Pago', e.dni_promesas || 0, pctPromesas, OBJETIVOS_EMBUDO.promesas, false) +
    filaEmbudo('Promesas Cumplidas', e.dni_promesas_cumplidas || 0, pctCumplidas, OBJETIVOS_EMBUDO.cumplidas, false) +
    filaEmbudo('Recaudación (sobre Cartera Asignada)', e.recaudacion || 0, pctRecaudacion, objetivoRecaudacion(unidadNegocio), true) +
    (esUnidadJudicial ? filaSoloMonto('Recaudación (Total Compañía)', e.recaudacion_total_compania || 0) : '');


  const c = (contactabilidadResp.data && contactabilidadResp.data[0]) || {};
  destruirSiExiste('grafico-contactabilidad');
  graficos['grafico-contactabilidad'] = new Chart(document.getElementById('grafico-contactabilidad'), {
    type: 'doughnut',
    data: {
      labels: ['DNI gestionados', 'DNI sin gestión'],
      datasets: [{ data: [c.dni_gestionados || 0, c.dni_sin_gestion || 0], backgroundColor: [COLOR_VERDE, COLOR_ROJO] }],
    },
    options: { responsive: true },
  });
}

// ============================================================
// CARGA DE GESTIONES
// ============================================================
document.getElementById('form-cargar-gestiones').addEventListener('submit', async (e) => {
  e.preventDefault();
  const estadoEl = document.getElementById('carga-estado');
  const boton = document.getElementById('btn-cargar-gestiones');
  estadoEl.textContent = 'Subiendo…';
  estadoEl.className = 'mensaje-estado';
  boton.disabled = true;
  const horaInicio = new Date().toISOString();

  const { data: { session } } = await supabaseClient.auth.getSession();
  const formData = new FormData();
  formData.append('archivo', document.getElementById('archivo-gestiones').files[0]);

  try {
    const respuesta = await fetch(`${CONFIG.BACKEND_URL}/upload-gestiones`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenSesion(session)}` },
      body: formData,
    });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.detail || 'Error desconocido');

    estadoEl.textContent = 'Procesando… esta pantalla se va a actualizar sola cuando termine.';
    estadoEl.className = 'mensaje-estado ok';
    cargarLogCargas();
    esperarFinalizacionYRefrescar(estadoEl, horaInicio, 'Listo — las gestiones ya están cargadas.');
  } catch (err) {
    estadoEl.textContent = `Error: ${err.message}`;
    estadoEl.className = 'mensaje-estado error';
  } finally {
    boton.disabled = false;
  }
});

async function esperarFinalizacionYRefrescar(estadoEl, horaInicioIso, mensajeExito) {
  const maxIntentos = 60; // 60 x 8s = 8 minutos como máximo
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

async function cargarLogCargas() {
  // cargas_log es una sola tabla compartida por los 3 tipos de carga
  // (Gestiones, Recupero, Cartera) — se muestra el mismo historial en
  // las 3 pestañas, así siempre se ve todo lo que se subió, sin
  // importar desde qué pestaña se hizo.
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
  ['#tabla-log', '#tabla-log-recupero', '#tabla-log-cartera', '#tabla-log-baja-cartera', '#tabla-log-masivos'].forEach(selector => {
    const tbody = document.querySelector(`${selector} tbody`);
    if (tbody) tbody.innerHTML = filasHtml;
  });
}

// ============================================================
// DAR DE BAJA CARTERA (mensual, unidades Tercerizadas)
// ============================================================
document.getElementById('form-baja-cartera').addEventListener('submit', async (e) => {
  e.preventDefault();
  const estadoEl = document.getElementById('baja-cartera-estado');
  const boton = document.getElementById('btn-baja-cartera');
  estadoEl.textContent = 'Subiendo…';
  estadoEl.className = 'mensaje-estado';
  boton.disabled = true;
  const horaInicio = new Date().toISOString();

  const { data: { session } } = await supabaseClient.auth.getSession();
  const formData = new FormData();
  formData.append('archivo', document.getElementById('archivo-baja-cartera').files[0]);
  formData.append('unidad_negocio', document.getElementById('baja-unidad-negocio').value);

  try {
    const respuesta = await fetch(`${CONFIG.BACKEND_URL}/baja-cartera`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenSesion(session)}` },
      body: formData,
    });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.detail || 'Error desconocido');

    estadoEl.textContent = 'Procesando… esta pantalla se va a actualizar sola cuando termine.';
    estadoEl.className = 'mensaje-estado ok';
    cargarLogCargas();
    esperarFinalizacionYRefrescar(estadoEl, horaInicio, 'Listo — las bajas ya se aplicaron.');
  } catch (err) {
    estadoEl.textContent = `Error: ${err.message}`;
    estadoEl.className = 'mensaje-estado error';
  } finally {
    boton.disabled = false;
  }
});

// ============================================================
// CARGA DE RECUPERO
// ============================================================
document.getElementById('form-cargar-recupero').addEventListener('submit', async (e) => {
  e.preventDefault();
  const estadoEl = document.getElementById('recupero-estado');
  const boton = document.getElementById('btn-cargar-recupero');
  estadoEl.textContent = 'Subiendo…';
  estadoEl.className = 'mensaje-estado';
  boton.disabled = true;
  const horaInicio = new Date().toISOString();

  const { data: { session } } = await supabaseClient.auth.getSession();
  const formData = new FormData();
  formData.append('archivo', document.getElementById('archivo-recupero').files[0]);
  formData.append('unidad_negocio', document.getElementById('recupero-unidad-negocio').value);

  try {
    const respuesta = await fetch(`${CONFIG.BACKEND_URL}/upload-recupero`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenSesion(session)}` },
      body: formData,
    });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.detail || 'Error desconocido');

    estadoEl.textContent = 'Procesando… esta pantalla se va a actualizar sola cuando termine.';
    estadoEl.className = 'mensaje-estado ok';
    cargarLogCargas();
    esperarFinalizacionYRefrescar(estadoEl, horaInicio, 'Listo — el Recupero ya está cargado.');
  } catch (err) {
    estadoEl.textContent = `Error: ${err.message}`;
    estadoEl.className = 'mensaje-estado error';
  } finally {
    boton.disabled = false;
  }
});

// ============================================================
// CARGA DE CARTERA (semanal, por unidad de negocio)
// ============================================================
document.getElementById('form-cargar-cartera').addEventListener('submit', async (e) => {
  e.preventDefault();
  const estadoEl = document.getElementById('cartera-estado');
  const boton = document.getElementById('btn-cargar-cartera');
  estadoEl.textContent = 'Subiendo…';
  estadoEl.className = 'mensaje-estado';
  boton.disabled = true;
  const horaInicio = new Date().toISOString();

  const { data: { session } } = await supabaseClient.auth.getSession();
  const formData = new FormData();
  formData.append('archivo', document.getElementById('archivo-cartera').files[0]);
  formData.append('unidad_negocio', document.getElementById('cartera-unidad-negocio').value);
  formData.append('solo_actualizar_existentes', document.getElementById('cartera-solo-actualizar').checked);

  try {
    const respuesta = await fetch(`${CONFIG.BACKEND_URL}/upload-cartera`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenSesion(session)}` },
      body: formData,
    });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.detail || 'Error desconocido');

    estadoEl.textContent = 'Procesando… esta pantalla se va a actualizar sola cuando termine (puede tardar un poco más porque también calcula la reasignación por días).';
    estadoEl.className = 'mensaje-estado ok';
    cargarLogCargas();
    esperarFinalizacionYRefrescar(estadoEl, horaInicio, 'Listo — la Cartera ya está cargada.');
  } catch (err) {
    estadoEl.textContent = `Error: ${err.message}`;
    estadoEl.className = 'mensaje-estado error';
  } finally {
    boton.disabled = false;
  }
});

// ============================================================
// CONFIGURACION DE AGENTES (alta / baja logica)
// ============================================================
document.getElementById('form-alta-agente').addEventListener('submit', async (e) => {
  e.preventDefault();
  const estadoEl = document.getElementById('alta-agente-estado');
  const boton = document.getElementById('btn-alta-agente');
  estadoEl.textContent = 'Guardando…';
  estadoEl.className = 'mensaje-estado';
  boton.disabled = true;

  const { data: { session } } = await supabaseClient.auth.getSession();
  const formData = new FormData();
  formData.append('unidad_negocio', document.getElementById('alta-unidad-negocio').value);
  formData.append('box', document.getElementById('alta-box').value);
  formData.append('agente', document.getElementById('alta-agente').value);
  formData.append('horas', document.getElementById('alta-horas').value);

  try {
    const respuesta = await fetch(`${CONFIG.BACKEND_URL}/agentes-box/alta`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenSesion(session)}` },
      body: formData,
    });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.detail || 'Error desconocido');

    estadoEl.textContent = resultado.mensaje || 'Agente agregado.';
    estadoEl.className = 'mensaje-estado ok';
    document.getElementById('form-alta-agente').reset();
    cargarTablaAgentesConfig();
  } catch (err) {
    estadoEl.textContent = `Error: ${err.message}`;
    estadoEl.className = 'mensaje-estado error';
  } finally {
    boton.disabled = false;
  }
});

document.getElementById('config-unidad-negocio').addEventListener('change', cargarTablaAgentesConfig);

async function cargarTablaAgentesConfig() {
  const unidad = document.getElementById('config-unidad-negocio').value;
  let query = supabaseClient.from('agentes_box').select('unidad_negocio, box, agente, horas, activo').order('unidad_negocio').order('box').order('agente');
  if (unidad) query = query.eq('unidad_negocio', unidad);
  const { data } = await query;

  document.querySelector('#tabla-agentes-config tbody').innerHTML = (data || []).map(a => `
    <tr>
      <td>${a.unidad_negocio}</td>
      <td>${a.box}</td>
      <td>${a.agente}${a.horas == null ? ' <span class="etiqueta-alias">(alias de escritura — no suma horas aparte)</span>' : ''}</td>
      <td class="numero">${a.horas != null ? a.horas : '—'}</td>
      <td>${a.activo ? 'Activo' : 'Baja'}</td>
      <td><button type="button" class="btn-secundario btn-toggle-agente" data-unidad="${a.unidad_negocio}" data-box="${a.box}" data-agente="${a.agente}" data-activo="${a.activo}">${a.activo ? 'Dar de baja' : 'Reactivar'}</button></td>
    </tr>`).join('');

  document.querySelectorAll('.btn-toggle-agente').forEach(boton => {
    boton.addEventListener('click', async () => {
      const { unidad: unidadNegocio, box, agente, activo } = boton.dataset;
      const accion = activo === 'true' ? 'baja' : 'reactivar';
      boton.disabled = true;
      const { data: { session } } = await supabaseClient.auth.getSession();
      const formData = new FormData();
      formData.append('unidad_negocio', unidadNegocio);
      formData.append('box', box);
      formData.append('agente', agente);
      try {
        const respuesta = await fetch(`${CONFIG.BACKEND_URL}/agentes-box/${accion}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${tokenSesion(session)}` },
          body: formData,
        });
        const resultado = await respuesta.json();
        if (!respuesta.ok) throw new Error(resultado.detail || 'Error desconocido');
        cargarTablaAgentesConfig();
      } catch (err) {
        alert(`Error: ${err.message}`);
        boton.disabled = false;
      }
    });
  });
}

document.getElementById('btn-reasignar-vacios').addEventListener('click', async () => {
  const unidad = document.getElementById('config-unidad-negocio').value;
  const estadoEl = document.getElementById('reasignar-vacios-estado');
  if (!unidad) {
    estadoEl.textContent = 'Elegí primero una unidad en el filtro.';
    estadoEl.className = 'mensaje-estado error';
    return;
  }
  const boton = document.getElementById('btn-reasignar-vacios');
  boton.disabled = true;
  estadoEl.textContent = 'Calculando…';
  estadoEl.className = 'mensaje-estado';
  const llamar = async (simular) => {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const formData = new FormData();
    formData.append('unidad_negocio', unidad);
    formData.append('simular', simular ? 'true' : 'false');
    const respuesta = await fetch(`${CONFIG.BACKEND_URL}/reasignar-cartera-boxes-vacios`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenSesion(session)}` },
      body: formData,
    });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.detail || 'Error desconocido');
    return resultado;
  };
  try {
    const sim = await llamar(true);
    if (!sim.fichas) {
      estadoEl.textContent = 'No hay boxes sin agentes con cartera para reasignar.';
      estadoEl.className = 'mensaje-estado ok';
      return;
    }
    const detalle = Object.entries(sim.destino).map(([b, n]) => `  ${b}: +${n}`).join('\n');
    const ok = confirm(`${unidad}\n\nBoxes sin agentes: ${sim.boxes_vacios.join(', ')}\nSe reasignan ${sim.fichas} fichas (${sim.dnis} DNI):\n${detalle}\n\n¿Aplicar?`);
    if (!ok) {
      estadoEl.textContent = 'Cancelado, no se modificó nada.';
      return;
    }
    estadoEl.textContent = 'Aplicando…';
    const res = await llamar(false);
    estadoEl.textContent = `Listo: ${res.fichas} fichas (${res.dnis} DNI) reasignadas.`;
    estadoEl.className = 'mensaje-estado ok';
  } catch (err) {
    estadoEl.textContent = `Error: ${err.message}`;
    estadoEl.className = 'mensaje-estado error';
  } finally {
    boton.disabled = false;
  }
});

document.querySelector('[data-vista="configuracion"]').addEventListener('click', cargarTablaAgentesConfig);

// ============================================================
// ALTA DE USUARIOS (login a la pagina)
// ============================================================
document.getElementById('form-alta-usuario').addEventListener('submit', async (e) => {
  e.preventDefault();
  const estadoEl = document.getElementById('alta-usuario-estado');
  const boton = document.getElementById('btn-alta-usuario');
  estadoEl.textContent = 'Creando…';
  estadoEl.className = 'mensaje-estado';
  boton.disabled = true;

  const { data: { session } } = await supabaseClient.auth.getSession();
  const formData = new FormData();
  formData.append('email', document.getElementById('alta-usuario-email').value);
  formData.append('password', document.getElementById('alta-usuario-password').value);
  formData.append('unidad_negocio', document.getElementById('alta-usuario-unidad').value);

  try {
    const respuesta = await fetch(`${CONFIG.BACKEND_URL}/usuarios/alta`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenSesion(session)}` },
      body: formData,
    });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.detail || 'Error desconocido');

    estadoEl.textContent = resultado.mensaje || 'Usuario creado.';
    estadoEl.className = 'mensaje-estado ok';
    document.getElementById('form-alta-usuario').reset();
  } catch (err) {
    estadoEl.textContent = `Error: ${err.message}`;
    estadoEl.className = 'mensaje-estado error';
  } finally {
    boton.disabled = false;
  }
});

// ============================================================
// SEGUIMIENTO: helpers compartidos
// ============================================================
async function llenarSelectorUnidadSimple(idSelect) {
  const { data } = await supabaseClient.rpc('unidades_negocio_disponibles');
  const select = document.getElementById(idSelect);
  (data || []).forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.unidad_negocio;
    opt.textContent = f.unidad_negocio;
    select.appendChild(opt);
  });
}

function descargarComoCsv(nombreArchivo, columnas, filas) {
  const escapar = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lineas = [columnas.map(escapar).join(',')];
  filas.forEach(f => lineas.push(columnas.map(c => escapar(f[c])).join(',')));
  const blob = new Blob(['\uFEFF' + lineas.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombreArchivo;
  a.click();
  URL.revokeObjectURL(url);
}

// Las funciones de Supabase devuelven como maximo 1000 filas por
// llamada -> se pagina con .range() hasta que una pagina vuelva con
// menos de 1000, para traer TODO el resultado sin importar el tamaño.
async function llamarRpcPaginado(nombreFuncion, parametros) {
  const filas = [];
  const tamanoPagina = 1000;
  let desde = 0;
  while (true) {
    const { data, error } = await supabaseClient
      .rpc(nombreFuncion, parametros)
      .range(desde, desde + tamanoPagina - 1);
    if (error) throw new Error(error.message);
    filas.push(...(data || []));
    if (!data || data.length < tamanoPagina) break;
    desde += tamanoPagina;
  }
  return filas;
}

// ============================================================
// PROMESAS VIGENTES
// ============================================================
// (llamadas movidas a mostrarApp, ver mas abajo -> estas quedan sin uso pero no rompen nada al quedar duplicadas)
let ultimasFilasPV = [];
document.getElementById('pv-unidad-negocio').addEventListener('change', cargarPromesasVigentes);
document.querySelector('[data-vista="promesas-vigentes"]').addEventListener('click', () => {
  if (document.getElementById('pv-unidad-negocio').value) cargarPromesasVigentes();
});

async function cargarPromesasVigentes() {
  const unidad = document.getElementById('pv-unidad-negocio').value;
  if (!unidad) return;
  const data = await llamarRpcPaginado('promesas_vigentes_lista', { p_unidad_negocio: unidad, fecha_desde: null, fecha_hasta: null });
  ultimasFilasPV = data || [];
  const formateadorMoneda = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

  document.getElementById('pv-kpis').innerHTML = `
    <div class="tarjeta-kpi"><span class="valor">${formateadorNumero.format(ultimasFilasPV.length)}</span><span class="etiqueta">Promesas vigentes</span></div>`;

  document.querySelector('#tabla-pv tbody').innerHTML = ultimasFilasPV.map(f => `
    <tr>
      <td>${f.dni_cliente}</td><td>${f.nombre_cliente || ''}</td><td>${f.usuario}</td><td>${f.empresa || ''}</td>
      <td class="numero">${f.promesa_monto != null ? formateadorMoneda.format(f.promesa_monto) : '—'}</td>
      <td>${f.promesa_fecha_pago || '—'}</td><td>${f.promesa_fecha_vencimiento || '—'}</td><td>${f.telefono || ''}</td>
    </tr>`).join('');

  const porAgente = {};
  ultimasFilasPV.forEach(f => { porAgente[f.usuario] = (porAgente[f.usuario] || 0) + 1; });
  const etiquetas = Object.keys(porAgente);
  destruirSiExiste('grafico-pv');
  graficos['grafico-pv'] = new Chart(document.getElementById('grafico-pv'), {
    type: 'bar',
    data: { labels: etiquetas, datasets: [{ label: 'Promesas vigentes', data: etiquetas.map(e => porAgente[e]), backgroundColor: COLOR_BRONCE }] },
    options: { responsive: true, plugins: { legend: { display: false } } },
  });
}

document.getElementById('btn-descargar-pv').addEventListener('click', () => {
  if (!ultimasFilasPV.length) { alert('No hay datos para descargar.'); return; }
  descargarComoCsv('Promesas_Vigentes.csv',
    ['dni_cliente', 'nombre_cliente', 'usuario', 'empresa', 'promesa_monto', 'promesa_fecha_pago', 'promesa_fecha_vencimiento', 'telefono'],
    ultimasFilasPV);
});

// ============================================================
// CONVENIOS
// ============================================================
let ultimasFilasConv = [];
document.getElementById('conv-unidad-negocio').addEventListener('change', cargarConvenios);
document.querySelector('[data-vista="convenios"]').addEventListener('click', () => {
  if (document.getElementById('conv-unidad-negocio').value) cargarConvenios();
});

async function cargarConvenios() {
  const unidad = document.getElementById('conv-unidad-negocio').value;
  if (!unidad) return;
  const data = await llamarRpcPaginado('convenios_detectados_lista', { p_unidad_negocio: unidad, fecha_desde: null, fecha_hasta: null });
  ultimasFilasConv = data || [];

  document.getElementById('conv-kpis').innerHTML = `
    <div class="tarjeta-kpi"><span class="valor">${formateadorNumero.format(ultimasFilasConv.length)}</span><span class="etiqueta">Convenios detectados</span></div>`;

  document.querySelector('#tabla-conv tbody').innerHTML = ultimasFilasConv.map(f => `
    <tr>
      <td>${f.dni_cliente}</td><td>${f.nombre_cliente || ''}</td><td>${f.usuario}</td><td>${f.fecha}</td>
      <td>${f.frase_detectada}</td><td>${(f.observaciones || '').slice(0, 120)}</td>
    </tr>`).join('');

  const porAgente = {};
  ultimasFilasConv.forEach(f => { porAgente[f.usuario] = (porAgente[f.usuario] || 0) + 1; });
  const etiquetas = Object.keys(porAgente);
  destruirSiExiste('grafico-conv');
  graficos['grafico-conv'] = new Chart(document.getElementById('grafico-conv'), {
    type: 'bar',
    data: { labels: etiquetas, datasets: [{ label: 'Convenios detectados', data: etiquetas.map(e => porAgente[e]), backgroundColor: COLOR_VERDE }] },
    options: { responsive: true, plugins: { legend: { display: false } } },
  });
}

document.getElementById('btn-descargar-conv').addEventListener('click', () => {
  if (!ultimasFilasConv.length) { alert('No hay datos para descargar.'); return; }
  descargarComoCsv('Convenios_Detectados.csv',
    ['dni_cliente', 'nombre_cliente', 'usuario', 'fecha', 'frase_detectada', 'observaciones'],
    ultimasFilasConv);
});

// ============================================================
// NO CONTACTADOS
// ============================================================
let ultimasFilasNC = [];
document.getElementById('nc-unidad-negocio').addEventListener('change', cargarNoContactados);
document.querySelector('[data-vista="no-contactados"]').addEventListener('click', () => {
  if (document.getElementById('nc-unidad-negocio').value) cargarNoContactados();
});

async function cargarNoContactados() {
  const unidad = document.getElementById('nc-unidad-negocio').value;
  if (!unidad) return;
  const data = await llamarRpcPaginado('cartera_no_contactados_lista', { p_unidad_negocio: unidad, fecha_desde: null, fecha_hasta: null });
  ultimasFilasNC = data || [];
  const formateadorMoneda = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

  document.getElementById('nc-kpis').innerHTML = `
    <div class="tarjeta-kpi"><span class="valor">${formateadorNumero.format(ultimasFilasNC.length)}</span><span class="etiqueta">Casos sin contacto logrado</span></div>`;

  document.querySelector('#tabla-nc tbody').innerHTML = ultimasFilasNC.slice(0, 500).map(f => `
    <tr>
      <td>${f.nro_documento}</td><td>${(f.nombre_causa || '').trim()}</td>
      <td class="numero">${formateadorMoneda.format(f.deuda_total || 0)}</td>
      <td>${f.box || ''}</td><td>${f.provincia || ''}</td>
      <td class="numero">${f.intentos}</td><td>${f.ultimo_intento || ''}</td><td>${f.ultimo_telefono || ''}</td>
    </tr>`).join('');
}

document.getElementById('btn-descargar-nc').addEventListener('click', () => {
  if (!ultimasFilasNC.length) { alert('No hay datos para descargar.'); return; }
  descargarComoCsv('No_Contactados_para_enriquecer.csv',
    ['nro_documento', 'nombre_causa', 'deuda_total', 'box', 'provincia', 'intentos', 'ultimo_intento', 'ultimo_telefono'],
    ultimasFilasNC);
});

// ============================================================
// SIN GESTION
// ============================================================
let ultimasFilasSG = [];
document.getElementById('sg-unidad-negocio').addEventListener('change', cargarSinGestion);
document.querySelector('[data-vista="sin-gestion"]').addEventListener('click', () => {
  if (document.getElementById('sg-unidad-negocio').value) cargarSinGestion();
});

async function cargarSinGestion() {
  const unidad = document.getElementById('sg-unidad-negocio').value;
  if (!unidad) return;
  const data = await llamarRpcPaginado('cartera_sin_gestion_lista', { p_unidad_negocio: unidad, fecha_desde: null, fecha_hasta: null });
  ultimasFilasSG = data || [];
  const formateadorMoneda = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

  document.getElementById('sg-kpis').innerHTML = `
    <div class="tarjeta-kpi"><span class="valor">${formateadorNumero.format(ultimasFilasSG.length)}</span><span class="etiqueta">DNI nunca tocados este período</span></div>`;

  document.querySelector('#tabla-sg tbody').innerHTML = ultimasFilasSG.slice(0, 500).map(f => `
    <tr>
      <td>${f.nro_documento}</td><td>${(f.nombre_causa || '').trim()}</td>
      <td class="numero">${formateadorMoneda.format(f.deuda_total || 0)}</td>
      <td>${f.box || ''}</td><td>${f.provincia || ''}</td>
    </tr>`).join('');
}

document.getElementById('btn-descargar-sg').addEventListener('click', () => {
  if (!ultimasFilasSG.length) { alert('No hay datos para descargar.'); return; }
  descargarComoCsv('Sin_Gestion.csv',
    ['nro_documento', 'nombre_causa', 'deuda_total', 'box', 'provincia'],
    ultimasFilasSG);
});

// ============================================================
// CARGAR MASIVOS
// ============================================================
document.getElementById('form-cargar-masivos').addEventListener('submit', async (e) => {
  e.preventDefault();
  const estadoEl = document.getElementById('masivos-estado');
  const boton = document.getElementById('btn-cargar-masivos');
  estadoEl.textContent = 'Subiendo…';
  estadoEl.className = 'mensaje-estado';
  boton.disabled = true;

  const { data: { session } } = await supabaseClient.auth.getSession();
  const formData = new FormData();
  formData.append('archivo', document.getElementById('archivo-masivos').files[0]);
  formData.append('unidad_negocio', document.getElementById('masivos-unidad-negocio').value);
  formData.append('canal', document.getElementById('masivos-canal').value);

  try {
    const respuesta = await fetch(`${CONFIG.BACKEND_URL}/upload-masivos`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenSesion(session)}` },
      body: formData,
    });
    const resultado = await respuesta.json();
    if (!respuesta.ok) throw new Error(resultado.detail || 'Error desconocido');

    estadoEl.textContent = 'Procesando… esta pantalla se va a actualizar sola cuando termine.';
    estadoEl.className = 'mensaje-estado ok';
    const horaInicio = new Date().toISOString();
    esperarFinalizacionYRefrescar(estadoEl, horaInicio, 'Listo — los envíos ya están cargados.');
  } catch (err) {
    estadoEl.textContent = `Error: ${err.message}`;
    estadoEl.className = 'mensaje-estado error';
  } finally {
    boton.disabled = false;
  }
});

// ============================================================
// COMPARATIVO (mensual y diario) — basado en Gestiones y Recupero
// ============================================================
document.getElementById('comp-unidad-negocio').addEventListener('change', cargarComparativo);
document.querySelector('[data-vista="comparativo"]').addEventListener('click', cargarComparativo);
document.getElementById('comp-mismo-dia-fecha').addEventListener('change', cargarMismoDia);

async function cargarMismoDia() {
  const unidad = document.getElementById('comp-unidad-negocio').value || null;
  const inputFecha = document.getElementById('comp-mismo-dia-fecha');
  if (!inputFecha.value) {
    // Por defecto: el ultimo dia con pagos cargados (o hoy si no se puede leer)
    let porDefecto = new Date().toISOString().slice(0, 10);
    try {
      const { data } = await supabaseClient.from('recupero').select('f_pago').order('f_pago', { ascending: false }).limit(1);
      if (data && data[0] && data[0].f_pago) porDefecto = data[0].f_pago;
    } catch (e) { /* se usa hoy */ }
    inputFecha.value = porDefecto;
  }
  const fecha = inputFecha.value;
  const { data } = await supabaseClient.rpc('comparativo_mismo_dia', { p_unidad_negocio: unidad, p_fecha: fecha, meses: 6 });
  const filas = data || [];
  const moneda = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  const etiqueta = f => new Date(f.fecha + 'T00:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
  const dia = Number(fecha.slice(8, 10));
  const hayAjuste = filas.some(f => Number(f.fecha.slice(8, 10)) !== dia);
  document.getElementById('comp-mismo-dia-nota').textContent =
    'Barras: lo recaudado ese día. Línea: acumulado del mes hasta ese día.' +
    (hayAjuste ? ' En los meses que no tienen ese día se usa el último día del mes.' : '');
  destruirSiExiste('grafico-comp-mismo-dia');
  graficos['grafico-comp-mismo-dia'] = new Chart(document.getElementById('grafico-comp-mismo-dia'), {
    data: {
      labels: filas.map(etiqueta),
      datasets: [
        { type: 'bar', label: 'Recaudación del día', data: filas.map(f => Number(f.recaudacion_dia)), backgroundColor: COLOR_VERDE },
        { type: 'line', label: 'Acumulado del mes hasta ese día', data: filas.map(f => Number(f.recaudacion_acumulada)), borderColor: COLOR_BRONCE, backgroundColor: COLOR_BRONCE, tension: 0.3 },
      ],
    },
    options: {
      responsive: true,
      plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${moneda.format(c.parsed.y)}` } } },
      scales: { y: { ticks: { callback: v => moneda.format(v) } } },
    },
  });
}

async function cargarComparativo() {
  const unidad = document.getElementById('comp-unidad-negocio').value || null;
  const formateadorMoneda = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  const formateadorMes = f => new Date(f + 'T00:00:00').toLocaleDateString('es-AR', { month: 'short', year: 'numeric' });

  cargarMismoDia();
  supabaseClient.rpc('recaudacion_judicial_por_empresa', { meses: 6 }).then(({ data }) => {
    const nombre = c => c === 'CFN S.R.L.' ? 'CFN' : (String(c).startsWith('ELECTRONICA MEGATONE') ? 'Megatone (On City)' : c);
    const filas = data || [];
    const m = formateadorMoneda;
    document.querySelector('#tabla-recaudacion-empresa tbody').innerHTML = filas.map(f => `
      <tr>
        <td>${formateadorMes(f.mes)}</td>
        <td>${nombre(f.compania)}</td>
        <td class="numero">${formateadorNumero.format(f.filas)}</td>
        <td class="numero">${m.format(f.monto_judicial)}</td>
        <td class="numero">${m.format(f.monto_gerenciar_recupera)}</td>
        <td class="numero">${m.format(f.monto_sin_unidad)}</td>
        <td class="numero"><strong>${m.format(f.monto_total)}</strong></td>
      </tr>`).join('');
  });
  const [{ data: mensual }, { data: diario }] = await Promise.all([
    supabaseClient.rpc('comparativo_mensual', { p_unidad_negocio: unidad, meses: 6 }),
    supabaseClient.rpc('comparativo_diario', { p_unidad_negocio: unidad, fecha_desde: null, fecha_hasta: null }),
  ]);

  const filasMes = mensual || [];
  document.querySelector('#tabla-comp-mensual tbody').innerHTML = filasMes.map(f => `
    <tr>
      <td>${formateadorMes(f.mes)}</td>
      <td class="numero">${formateadorNumero.format(f.total_gestiones)}</td>
      <td class="numero">${formateadorNumero.format(f.dni_trabajados)}</td>
      <td class="numero">${formateadorNumero.format(f.contacto_directo)}</td>
      <td class="numero">${formateadorPorcentaje.format(f.pct_efectividad)}</td>
      <td class="numero">${formateadorMoneda.format(f.recaudacion)}</td>
    </tr>`).join('');

  destruirSiExiste('grafico-comp-mensual');
  graficos['grafico-comp-mensual'] = new Chart(document.getElementById('grafico-comp-mensual'), {
    data: {
      labels: filasMes.map(f => formateadorMes(f.mes)),
      datasets: [
        { type: 'bar', label: 'Total Gestiones', data: filasMes.map(f => f.total_gestiones), backgroundColor: COLOR_TINTA, yAxisID: 'y' },
        { type: 'bar', label: 'Contacto Directo', data: filasMes.map(f => f.contacto_directo), backgroundColor: COLOR_BRONCE, yAxisID: 'y' },
        { type: 'line', label: 'Recaudación', data: filasMes.map(f => f.recaudacion), borderColor: COLOR_VERDE, backgroundColor: COLOR_VERDE, yAxisID: 'y1', tension: 0.3 },
      ],
    },
    options: {
      responsive: true,
      scales: {
        y: { position: 'left', title: { display: true, text: 'Gestiones' } },
        y1: { position: 'right', title: { display: true, text: 'Recaudación ($)' }, grid: { drawOnChartArea: false } },
      },
    },
  });

  const filasDia = diario || [];
  destruirSiExiste('grafico-comp-diario');
  graficos['grafico-comp-diario'] = new Chart(document.getElementById('grafico-comp-diario'), {
    type: 'line',
    data: {
      labels: filasDia.map(f => f.fecha),
      datasets: [
        { label: 'Total Gestiones', data: filasDia.map(f => f.total_gestiones), borderColor: COLOR_TINTA, tension: 0.3 },
        { label: 'Contacto Directo', data: filasDia.map(f => f.contacto_directo), borderColor: COLOR_BRONCE, tension: 0.3 },
      ],
    },
    options: { responsive: true },
  });
}


// ============================================================
// CIERRE DIARIO — cómo cerró un día cada agente
// ============================================================
(function iniciarCierreDiario() {
  const fecha = document.getElementById('cd-fecha');
  const mover = dias => {
    const d = new Date((fecha.value || new Date().toISOString().slice(0, 10)) + 'T00:00:00');
    d.setDate(d.getDate() + dias);
    fecha.value = d.toISOString().slice(0, 10);
    cargarCierreDiario();
  };
  document.getElementById('cd-anterior').addEventListener('click', () => mover(-1));
  document.getElementById('cd-siguiente').addEventListener('click', () => mover(1));
  document.getElementById('cd-ultimo').addEventListener('click', async () => { await fijarUltimoDiaCargado(); cargarCierreDiario(); });
  fecha.addEventListener('change', cargarCierreDiario);
  document.getElementById('cd-unidad-negocio').addEventListener('change', cargarCierreDiario);
  document.getElementById('cd-descargar').addEventListener('click', () => {
    const cols = ['usuario', 'empresa', 'gestiones', 'dni_trabajados', 'contacto_directo', 'contacto_indirecto', 'sin_contacto', 'pct_efectividad', 'pagos', 'recupero_atribuido'];
    descargarComoCsv(`cierre_diario_${fecha.value}.csv`, cols, window._cierreDiarioFilas || []);
  });
  document.querySelector('[data-vista="cierre-diario"]').addEventListener('click', async () => {
    if (!fecha.value) await fijarUltimoDiaCargado();
    cargarCierreDiario();
  });
})();

async function fijarUltimoDiaCargado() {
  const { data } = await supabaseClient.from('gestiones').select('fecha').order('fecha', { ascending: false }).limit(1);
  document.getElementById('cd-fecha').value = (data && data[0] && data[0].fecha) || new Date().toISOString().slice(0, 10);
}

async function cargarCierreDiario() {
  const fecha = document.getElementById('cd-fecha').value;
  if (!fecha) return;
  const unidad = document.getElementById('cd-unidad-negocio').value || null;
  const { data } = await supabaseClient.rpc('cierre_diario', { p_fecha: fecha, p_unidad_negocio: unidad, p_empresa: null });
  const filas = data || [];
  window._cierreDiarioFilas = filas;
  const moneda = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  const pct = v => `${(Number(v) * 100).toFixed(1).replace('.', ',')}%`;
  const suma = k => filas.reduce((a, f) => a + Number(f[k] || 0), 0);
  const tot = { g: suma('gestiones'), d: suma('dni_trabajados'), cd: suma('contacto_directo'), ci: suma('contacto_indirecto'),
                sc: suma('sin_contacto'), p: suma('pagos'), m: suma('recupero_atribuido') };

  const diaTxt = new Date(fecha + 'T00:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  document.getElementById('cd-titulo').textContent = `Detalle por agente — ${diaTxt}${unidad ? ` · ${unidad}` : ''}`;
  document.getElementById('cd-kpis').innerHTML = [
    ['Agentes activos', formateadorNumero.format(filas.length)],
    ['Gestiones', formateadorNumero.format(tot.g)],
    ['DNI trabajados', formateadorNumero.format(tot.d)],
    ['Contacto directo', `${formateadorNumero.format(tot.cd)} (${pct(tot.d ? tot.cd / tot.d : 0)})`],
    ['Pagos atribuidos', formateadorNumero.format(tot.p)],
    ['Recupero atribuido', moneda.format(tot.m)],
  ].map(([t, v]) => `<div class="tarjeta-kpi"><span class="valor">${v}</span><span class="etiqueta">${t}</span></div>`).join('');

  const fila = f => `<tr><td>${f.usuario}</td><td>${f.empresa || ''}</td>
    <td class="numero">${formateadorNumero.format(f.gestiones)}</td><td class="numero">${formateadorNumero.format(f.dni_trabajados)}</td>
    <td class="numero">${formateadorNumero.format(f.contacto_directo)}</td><td class="numero">${formateadorNumero.format(f.contacto_indirecto)}</td>
    <td class="numero">${formateadorNumero.format(f.sin_contacto)}</td><td class="numero">${pct(f.pct_efectividad)}</td>
    <td class="numero">${formateadorNumero.format(f.pagos)}</td><td class="numero">${moneda.format(f.recupero_atribuido)}</td></tr>`;
  document.querySelector('#tabla-cierre-diario tbody').innerHTML = filas.length
    ? filas.map(fila).join('') + `<tr style="font-weight:600"><td>TOTAL</td><td></td>
        <td class="numero">${formateadorNumero.format(tot.g)}</td><td class="numero">${formateadorNumero.format(tot.d)}</td>
        <td class="numero">${formateadorNumero.format(tot.cd)}</td><td class="numero">${formateadorNumero.format(tot.ci)}</td>
        <td class="numero">${formateadorNumero.format(tot.sc)}</td><td class="numero">${pct(tot.d ? tot.cd / tot.d : 0)}</td>
        <td class="numero">${formateadorNumero.format(tot.p)}</td><td class="numero">${moneda.format(tot.m)}</td></tr>`
    : '<tr><td colspan="10">No hay gestiones cargadas para ese día.</td></tr>';
  document.getElementById('cd-nota').textContent = 'Los pagos aparecen cuando se carga el Recupero de ese día; si todavía no se cargó, la columna figura en cero.';
}

// ============================================================
// RECUPERO DIARIO — casos cobrados y monto, mismo dia de cada mes
// ============================================================
(function iniciarRecuperoDiario() {
  const selDia = document.getElementById('rd-dia');
  for (let d = 1; d <= 31; d++) {
    const opt = document.createElement('option');
    opt.value = d; opt.textContent = `Día ${d}`;
    selDia.appendChild(opt);
  }
  selDia.value = String(new Date().getDate());
  ['rd-unidad-negocio', 'rd-dia', 'rd-meses', 'rd-modo'].forEach(id =>
    document.getElementById(id).addEventListener('change', cargarRecuperoDiario));
  document.querySelector('[data-vista="recupero-diario"]').addEventListener('click', cargarRecuperoDiario);
})();

async function cargarRecuperoDiario() {
  const unidad = document.getElementById('rd-unidad-negocio').value || null;
  const dia = Number(document.getElementById('rd-dia').value);
  const meses = Number(document.getElementById('rd-meses').value);
  const acumulado = document.getElementById('rd-modo').value === 'acumulado';
  const { data } = await supabaseClient.rpc('recupero_diario_comparado', {
    p_unidad_negocio: unidad, p_dia: dia, meses, p_acumulado: acumulado,
  });
  const filas = data || [];
  const moneda = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  const fmtMes = f => new Date(f + 'T00:00:00').toLocaleDateString('es-AR', { month: 'short', year: 'numeric' });
  const fmtDia = f => new Date(f + 'T00:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
  const periodo = f => f.desde === f.hasta ? fmtDia(f.hasta) : `${fmtDia(f.desde)} al ${fmtDia(f.hasta)}`;

  document.getElementById('rd-titulo').textContent =
    `Casos cobrados y monto — ${acumulado ? `del 1 al ${dia}` : `solo el día ${dia}`} de cada mes${unidad ? ` · ${unidad}` : ''}`;

  document.querySelector('#tabla-recupero-diario tbody').innerHTML = filas.map(f => `
    <tr><td>${fmtMes(f.mes)}</td><td>${periodo(f)}</td>
    <td class="numero">${formateadorNumero.format(f.casos)}</td>
    <td class="numero">${moneda.format(f.monto)}</td></tr>`).join('');

  destruirSiExiste('grafico-recupero-diario');
  graficos['grafico-recupero-diario'] = new Chart(document.getElementById('grafico-recupero-diario'), {
    data: {
      labels: filas.map(f => fmtMes(f.mes)),
      datasets: [
        { type: 'bar', label: 'Casos cobrados', data: filas.map(f => Number(f.casos)), backgroundColor: 'rgba(63,107,79,0.35)', yAxisID: 'y1', order: 2 },
        { type: 'line', label: 'Monto recaudado', data: filas.map(f => Number(f.monto)), borderColor: COLOR_BRONCE, backgroundColor: COLOR_BRONCE, tension: 0.3, yAxisID: 'y', order: 1 },
      ],
    },
    options: {
      responsive: true,
      plugins: { tooltip: { callbacks: {
        title: items => { const f = filas[items[0].dataIndex]; return `${fmtMes(f.mes)} (${periodo(f)})`; },
        label: c => c.dataset.yAxisID === 'y' ? `Monto: ${moneda.format(c.parsed.y)}` : `Casos cobrados: ${formateadorNumero.format(c.parsed.y)}`,
      } } },
      scales: {
        y: { position: 'left', title: { display: true, text: 'Monto ($)' }, ticks: { callback: v => moneda.format(v) } },
        y1: { position: 'right', title: { display: true, text: 'Casos cobrados' }, grid: { drawOnChartArea: false } },
      },
    },
  });
}
