// ============================================================
// VISTA: INFORME DE RECUPERO (reproduce el "Informe de Recupero" de Gerencia)
// Fuente: función informe_recupero_mensual() en Supabase.
//  - EM / CFN / CONFINA con embargo SÍ (judicial) y NO (extrajudicial): recupero_diario_detalle
//  - Cartera tercerizada: tabla recupero_tercerizado_mensual
// Depende de app.js (supabaseClient, COLOR_*, formateadorMoneda, formateadorNumero).
// ============================================================
(function () {
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const etiquetaMes = (iso) => `${MESES[Number(iso.slice(5, 7)) - 1]}-${iso.slice(2, 4)}`;
  const fmtMillones = (v) => `$${(v / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 })} M`;

  const filas = []; // {mes, compania, concepto, monto, cantidad}
  const instancias = {};
  let cargado = false;
  let rango = 24;
  let incluirMesEnCurso = false;

  const es = (c, ...conceptos) => (f) => (c === null || f.compania === c) && conceptos.includes(f.concepto);
  const GRUPOS = [
    { id: 'tot-gestion', titulo: 'Total gestión (sin tercerizada)', color: COLOR_TINTA, abierto: true, filtro: es(null, 'EMBARGO SI', 'EMBARGO NO') },
    { id: 'tot-jud', titulo: 'Total judicial (embargo SÍ)', color: COLOR_JUDICIAL, abierto: true, filtro: es(null, 'EMBARGO SI') },
    { id: 'tot-ext', titulo: 'Total extrajudicial (embargo NO)', color: COLOR_EXTRAJUDICIAL, abierto: true, filtro: es(null, 'EMBARGO NO') },
    { id: 'tot-terc', titulo: 'Total cartera tercerizada', color: COLOR_VERDE, filtro: es(null, 'TERCERIZADA') },
    { id: 'tot-gral', titulo: 'Total general (gestión + tercerizada)', color: COLOR_TINTA, filtro: es(null, 'EMBARGO SI', 'EMBARGO NO', 'TERCERIZADA') },
    ...[['EM', 'Electrónica Megatone', COLOR_EM], ['CFN', 'CFN', COLOR_CFN]].flatMap(([c, n, col]) => [
      { id: `${c}-si`, titulo: `${n} — embargo SÍ`, color: col, filtro: es(c, 'EMBARGO SI') },
      { id: `${c}-no`, titulo: `${n} — embargo NO`, color: col, filtro: es(c, 'EMBARGO NO') },
      { id: `${c}-sub`, titulo: `${n} — subtotal gestión`, color: col, filtro: es(c, 'EMBARGO SI', 'EMBARGO NO') },
      { id: `${c}-terc`, titulo: `${n} — cartera tercerizada`, color: col, filtro: es(c, 'TERCERIZADA') },
      { id: `${c}-tot`, titulo: `${n} — total compañía`, color: col, filtro: es(c, 'EMBARGO SI', 'EMBARGO NO', 'TERCERIZADA') },
    ]),
    { id: 'CONFINA-si', titulo: 'Confina — embargo SÍ', color: COLOR_CONFINA, filtro: es('CONFINA', 'EMBARGO SI') },
    { id: 'CONFINA-no', titulo: 'Confina — embargo NO', color: COLOR_CONFINA, filtro: es('CONFINA', 'EMBARGO NO') },
    { id: 'CONFINA-sub', titulo: 'Confina — subtotal', color: COLOR_CONFINA, filtro: es('CONFINA', 'EMBARGO SI', 'EMBARGO NO') },
  ];

  function serie(grupo) {
    const porMes = new Map();
    filas.filter(grupo.filtro).forEach((f) => {
      const a = porMes.get(f.mes) || { monto: 0, cantidad: 0 };
      a.monto += Number(f.monto) || 0;
      a.cantidad += Number(f.cantidad) || 0;
      porMes.set(f.mes, a);
    });
    return porMes;
  }

  function mesActual() {
    const h = new Date();
    return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-01`;
  }

  function dibujar(grupo, canvasId, clave, formatoValor) {
    const todo = serie(grupo);
    let meses = [...todo.keys()].sort();
    const base = meses.find((m) => todo.get(m)[clave] > 0);         // primer mes con dato = base de la relación
    const valorBase = base ? todo.get(base)[clave] : 0;
    if (!incluirMesEnCurso) meses = meses.filter((m) => m < mesActual());
    meses = meses.filter((m) => todo.get(m)[clave] > 0);            // sin meses vacíos
    meses = meses.slice(-rango);

    if (instancias[canvasId]) instancias[canvasId].destroy();
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    instancias[canvasId] = new Chart(canvas, {
      data: {
        labels: meses.map(etiquetaMes),
        datasets: [
          {
            type: 'bar', label: clave === 'monto' ? 'Recupero $' : 'Q fichas',
            data: meses.map((m) => todo.get(m)[clave]),
            backgroundColor: grupo.color + '55', borderColor: grupo.color, borderWidth: 1, order: 2, yAxisID: 'y',
          },
          {
            type: 'line', label: base ? `Relación vs ${etiquetaMes(base)}` : 'Relación',
            data: meses.map((m) => (valorBase ? todo.get(m)[clave] / valorBase : null)),
            borderColor: COLOR_BRONCE, backgroundColor: COLOR_BRONCE, tension: 0.25, pointRadius: 2, order: 0, yAxisID: 'y2',
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: { callbacks: { label: (c) => (c.dataset.type === 'line' ? `${c.dataset.label}: ${c.parsed.y.toFixed(2)}x` : `${c.dataset.label}: ${formatoValor(c.parsed.y)}`) } },
        },
        scales: {
          y: { beginAtZero: true, ticks: { callback: (v) => formatoValor(v) }, grid: { color: COLOR_LINEA } },
          y2: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { callback: (v) => `${v}x` } },
        },
      },
    });
  }

  function armarEstructura() {
    const cont = document.getElementById('informe-grilla');
    cont.innerHTML = GRUPOS.map((g) => `
      <details class="tarjeta-grafico ancho-completo desplegable" data-grupo="${g.id}" ${g.abierto ? 'open' : ''}>
        <summary>${g.titulo}</summary>
        <div class="informe-par">
          <div class="informe-caja"><h4>Recupero $</h4><canvas id="inf-m-${g.id}"></canvas></div>
          <div class="informe-caja"><h4>Cantidad de fichas (Q)</h4><canvas id="inf-q-${g.id}"></canvas></div>
        </div>
      </details>`).join('');
    cont.querySelectorAll('details').forEach((d) => d.addEventListener('toggle', () => d.open && pintarGrupo(d.dataset.grupo)));
  }

  function pintarGrupo(id) {
    const g = GRUPOS.find((x) => x.id === id);
    if (!g) return;
    dibujar(g, `inf-m-${id}`, 'monto', fmtMillones);
    dibujar(g, `inf-q-${id}`, 'cantidad', (v) => formateadorNumero.format(v));
  }

  function repintarAbiertos() {
    document.querySelectorAll('#informe-grilla details[open]').forEach((d) => pintarGrupo(d.dataset.grupo));
  }

  function tarjetasResumen() {
    const mensual = serie(GRUPOS[4]); // total general
    const meses = [...mensual.keys()].sort().filter((m) => m < mesActual());
    const ult = meses[meses.length - 1];
    const ant = meses[meses.length - 2];
    const prev = meses[meses.length - 13];
    if (!ult) return;
    const v = mensual.get(ult).monto;
    const cmp = (otro) => { if (!otro) return '—'; const p = ((v / mensual.get(otro).monto) - 1) * 100; return `${p > 0 ? '+' : ''}${p.toFixed(1)}%`; };
    const tarjeta = (valor, etiqueta) => `<div class="tarjeta-kpi"><span class="valor">${valor}</span><span class="etiqueta">${etiqueta}</span></div>`;
    document.getElementById('informe-kpis').innerHTML =
      tarjeta(fmtMillones(v), `Total general ${etiquetaMes(ult)}`) +
      tarjeta(cmp(ant), `vs ${ant ? etiquetaMes(ant) : '—'}`) +
      tarjeta(cmp(prev), `vs ${prev ? etiquetaMes(prev) : '—'} (año anterior)`);
  }

  async function cargarInforme() {
    const { data, error } = await supabaseClient.rpc('informe_recupero_mensual');
    if (error) {
      document.getElementById('informe-grilla').innerHTML = `<p class="ayuda">No se pudo cargar el informe: ${error.message}</p>`;
      return;
    }
    filas.length = 0;
    (data || []).forEach((f) => filas.push(f));
    armarEstructura();
    tarjetasResumen();
    cargado = true;
    repintarAbiertos();
  }

  document.getElementById('nav-pestanas').addEventListener('click', (e) => {
    const b = e.target.closest('.pestana');
    if (b && b.dataset.vista === 'informe' && !cargado) cargarInforme();
  });
  document.getElementById('informe-rango').addEventListener('change', (e) => { rango = Number(e.target.value); repintarAbiertos(); });
  document.getElementById('informe-mes-curso').addEventListener('change', (e) => { incluirMesEnCurso = e.target.checked; repintarAbiertos(); });
})();
