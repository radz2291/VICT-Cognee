/* C6 pilot browser client — display + interaction ONLY.
 * No capability logic here: every action is a POST /api/act, and the server
 * (which holds the runtime + authority profile) does all mapping. */

const state = { domain: 'a', selected: new Set(), lastDatasets: [] };

const $ = (id) => document.getElementById(id);
const el = {
  domains: $('domains'), datasetName: $('datasetName'), note: $('note'),
  addOut: $('addOut'), picker: $('datasetPicker'), query: $('query'),
  candidates: $('candidates'), searchOut: $('searchOut'), statusOut: $('statusOut'),
  forgetOut: $('forgetOut'), forgetConfirm: $('forgetConfirm'), nsNote: $('nsNote'),
};

const SAMPLE_MIXED =
  'Nota ringkas: sistem memerlukan dual approval untuk sebarang pembayaran besar. ' +
  'Payments above RM 50,000 require dual approval and a recorded maker-checker step.';

function setDomain(id) {
  state.domain = id; state.selected.clear();
  for (const btn of el.domains.children) {
    btn.classList.toggle('active', btn.dataset.id === id);
  }
  el.addOut.textContent = ''; el.searchOut.textContent = '';
  el.candidates.innerHTML = ''; el.forgetOut.textContent = '';
  refreshStatus();
}

async function act(action, input) {
  const res = await fetch('/api/act', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ domain: state.domain, action, input }),
  });
  return res.json();
}

function show(out, result) {
  const lines = [];
  if (result.error) lines.push(`✗ ${result.error.code}: ${result.error.message}`);
  if (result.status) lines.push(`run.status: ${result.status}${result.durationMs ? ` · ${result.durationMs} ms` : ''}`);
  if (result.output) lines.push('output: ' + JSON.stringify(result.output, null, 2));
  out.textContent = lines.join('\n') || JSON.stringify(result);
}

/* ---- trust-domain tabs ---- */
function renderDomains(meta) {
  el.domains.innerHTML = '';
  for (const id of meta.domains) {
    const btn = document.createElement('button');
    btn.textContent = id === 'a' ? 'A · notes domain' : 'B · vault domain';
    btn.dataset.id = id; btn.classList.add('domain');
    if (id === state.domain) btn.classList.add('active');
    btn.onclick = () => setDomain(id);
    el.domains.appendChild(btn);
  }
}

/* ---- status (cognee.datasetsStatus through the runtime) ---- */
async function refreshStatus() {
  const r = await act('status', {});
  el.statusOut.innerHTML = '';
  if (r.status === 'completed' && r.output) {
    el.nsNote.textContent = r.output.namespaces.join(', ');
    const list = document.createElement('ul');
    if (r.output.datasets.length === 0) {
      const li = document.createElement('li'); li.textContent = 'no datasets yet';
      list.appendChild(li);
    }
    for (const d of r.output.datasets) {
      const li = document.createElement('li'); li.textContent = d.name;
      list.appendChild(li);
    }
    el.statusOut.appendChild(list);
    const hidden = document.createElement('p');
    hidden.className = 'hint';
    hidden.textContent = r.output.hiddenDatasets > 0
      ? `${r.output.hiddenDatasets} dataset(s) exist on this store but are hidden by the namespace scope — ` +
        'the other domain\'s data is never named.'
      : 'store-scope filter: nothing hidden for this domain.';
    el.statusOut.appendChild(hidden);
    state.lastDatasets = r.output.datasets.map((d) => d.name);
    renderPicker();
  } else {
    el.statusOut.textContent = JSON.stringify(r, null, 2);
  }
}

function renderPicker() {
  el.picker.innerHTML = '';
  if (state.lastDatasets.length === 0) {
    el.picker.innerHTML = '<span class="hint">no datasets yet — add a note first</span>';
    return;
  }
  for (const name of state.lastDatasets) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = name;
    if (state.selected.has(name)) cb.checked = true;
    cb.onchange = () => { cb.checked ? state.selected.add(name) : state.selected.delete(name); };
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + name));
    el.picker.appendChild(label);
  }
}

/* ---- search (candidates only) ---- */
function renderCandidates(result) {
  el.candidates.innerHTML = '';
  const banner = document.createElement('p');
  banner.className = 'banner';
  banner.textContent = 'CANDIDATES — retrieval output, not an answer. No threshold is applied by the pack or this app.';
  el.candidates.appendChild(banner);
  const out = result.output;
  if (!out || !out.hits || out.hits.length === 0) {
    const p = document.createElement('p'); p.className = 'empty';
    p.textContent = 'No candidates returned. (Off-corpus queries legitimately return nothing or weak matches — ' +
      'there is no universal relevance threshold.)';
    el.candidates.appendChild(p);
    return;
  }
  for (const hit of out.hits) {
    const div = document.createElement('div');
    div.className = 'hit';
    const head = document.createElement('div');
    head.className = 'hit-head';
    head.textContent = `candidate · dataset ${hit.datasetName ?? '?'}` +
      (hit.score !== undefined ? ` · score ${hit.score}` : ' · (no score returned)');
    const body = document.createElement('div');
    body.className = 'hit-text'; body.textContent = hit.text;
    div.appendChild(head); div.appendChild(body);
    el.candidates.appendChild(div);
  }
}

/* ---- wire buttons ---- */
$('btnAdd').onclick = async () => {
  const r = await act('addNote', { datasetName: el.datasetName.value.trim(), content: el.note.value });
  show(el.addOut, r);
  if (r.status === 'completed') refreshStatus();
};
$('btnCognify').onclick = async () => {
  el.addOut.textContent = 'cognify running… (first run can take a minute)';
  const r = await act('cognify', { datasetName: el.datasetName.value.trim() });
  show(el.addOut, r);
};
$('btnSampleMixed').onclick = () => {
  el.note.value = SAMPLE_MIXED;
  el.datasetName.value = state.domain === 'a' ? 'notes.melayu' : 'vault.melayu';
};
$('btnSearch').onclick = async () => {
  const r = await act('searchChunks', { datasets: [...state.selected], query: el.query.value });
  el.searchOut.textContent = r.error ? `✗ ${r.error.code}: ${r.error.message}` : '';
  renderCandidates(r);
};
$('btnSearchSummaries').onclick = async () => {
  const r = await act('searchSummaries', { datasets: [...state.selected], query: el.query.value });
  el.searchOut.textContent = r.error ? `✗ ${r.error.code}: ${r.error.message}` : '';
  renderCandidates(r);
};
$('btnOffCorpus').onclick = () => {
  el.query.value = 'quarterly orbital telescope maintenance schedule';
};
$('btnStatus').onclick = refreshStatus;
$('btnForgetDefault').onclick = async () => {
  const r = await act('forgetDefault', { datasetName: el.datasetName.value.trim() });
  show(el.forgetOut, r);
};
$('btnForgetArmed').onclick = async () => {
  const r = await act('forgetArmed', {
    datasetName: el.datasetName.value.trim(), confirm: el.forgetConfirm.value.trim(),
  });
  show(el.forgetOut, r);
  if (r.status === 'completed') refreshStatus();
};

/* ---- boot ---- */
(async () => {
  const health = await (await fetch('/api/health')).json();
  renderDomains(health);
  document.title += ` — ${health.armedDelete ? 'DELETE ARMED' : 'delete denied'}`;
  await refreshStatus();
})();