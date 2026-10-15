// Servidor do Dashboard Unificado de Movimentação Processual (PJe + eProc).
// Uso local: node servidor.js   →   abra http://localhost:8787
// Na nuvem (Render etc.): a porta vem da variável PORT e o servidor aceita acessos externos.
// Não tem dependências: requer Node.js 22 ou superior (fetch e WebSocket nativos).
//
// Ao receber /api/dados, abre uma sessão anônima no Qlik Sense do TJMG, aplica as mesmas
// seleções dos painéis originais e lê os dados ao vivo. Para não sobrecarregar o Qlik com
// muitos acessos, a resposta é reaproveitada por CACHE_MINUTOS (padrão 5).
//
// Variáveis de ambiente opcionais:
//   PORT / PORTA     porta HTTP (padrão 8787)
//   CACHE_MINUTOS    tempo de reaproveitamento da consulta ao Qlik (padrão 5; 0 desliga)

const http = require('http');
const fs = require('fs');
const path = require('path');

const NA_NUVEM = !!process.env.PORT;
const CONFIG = {
  porta: Number(process.env.PORT || process.env.PORTA) || 8787,
  host: NA_NUVEM ? '0.0.0.0' : '127.0.0.1',
  cacheMs: (process.env.CACHE_MINUTOS === undefined ? 5 : Number(process.env.CACHE_MINUTOS)) * 60000,
  qlik: process.env.QLIK_URL || 'https://qlik.tjmg.jus.br',
  pje: {
    appId: '4b327cf1-95c1-4a28-a9c7-d78b2f00bc9c',
    painel: 'https://qlik.tjmg.jus.br/single/?appid=4b327cf1-95c1-4a28-a9c7-d78b2f00bc9c&sheet=5ff443e2-6808-4b86-a937-181c67587201&opt=ctxmenu,currsel',
    selecoes: {
      'Comarca': 'SETE LAGOAS',
      'Órgão Julgador': '1ª Vara Cível da comarca de Sete Lagoas',
    },
  },
  eproc: {
    appId: 'a08613b7-4f3b-43ea-8582-755e0e93081e',
    painel: 'https://qlik.tjmg.jus.br/single/?appid=a08613b7-4f3b-43ea-8582-755e0e93081e&sheet=9eb3b19a-9203-4eb8-97a4-561cc4e09f15&opt=ctxmenu,currsel',
    selecoes: {
      'Comarca_EPROC': 'Sete Lagoas',
      'Órgão Julgador_EPROC2': '1ª Vara Cível da Comarca de Sete Lagoas',
    },
  },
};

const CACHE = path.join(__dirname, 'ultima-consulta.json');
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

// ---------- Cliente mínimo da Engine API do Qlik ----------

async function abrirSessao(appId) {
  const jar = {};
  const guardar = r => r.headers.getSetCookie().forEach(c => {
    const kv = c.split(';')[0]; const i = kv.indexOf('=');
    jar[kv.slice(0, i)] = kv.slice(i + 1);
  });
  const cookies = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

  // 1) carregar a página do app cria a sessão anônima (cookie X-Qlik-Session)
  try {
    guardar(await fetch(`${CONFIG.qlik}/single/?appid=${appId}`, { headers: { Cookie: cookies() }, signal: AbortSignal.timeout(20000) }));
  } catch {
    throw new Error(`Servidor Qlik inacessível (${CONFIG.qlik}). Verifique a conexão com a rede do TJMG.`);
  }
  // 2) token CSRF exigido pelo servidor para abrir o WebSocket
  const xrf = 'dashunificado123';
  const t = await fetch(`${CONFIG.qlik}/qps/csrftoken?xrfkey=${xrf}`, { headers: { 'X-Qlik-Xrfkey': xrf, Cookie: cookies() } });
  guardar(t);
  const token = t.headers.get('qlik-csrf-token');
  if (!token) throw new Error(`Qlik não forneceu token de sessão (HTTP ${t.status}).`);

  const ws = new WebSocket(`${CONFIG.qlik.replace('https', 'wss')}/app/${appId}?qlik-csrf-token=${token}`,
    { headers: { Cookie: cookies(), Origin: CONFIG.qlik } });
  let seq = 0; const pend = {};
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend[m.id]) { const { ok, ko } = pend[m.id]; delete pend[m.id]; m.error ? ko(new Error(`${m.error.message} ${m.error.parameter || ''}`)) : ok(m.result); }
  };
  await new Promise((ok, ko) => {
    const to = setTimeout(() => ko(new Error('Tempo esgotado ao conectar no Qlik.')), 20000);
    ws.onopen = () => { clearTimeout(to); ok(); };
    ws.onerror = () => { clearTimeout(to); ko(new Error('Falha ao abrir conexão com o Qlik.')); };
  });
  const call = (method, handle, params = []) => new Promise((ok, ko) => {
    const id = ++seq; pend[id] = { ok, ko };
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, handle, params }));
    setTimeout(() => { if (pend[id]) { delete pend[id]; ko(new Error(`Tempo esgotado em ${method}.`)); } }, 60000);
  });

  const doc = (await call('OpenDoc', -1, [appId])).qReturn.qHandle;
  return {
    async selecionar(campo, valores) {
      const f = (await call('GetField', doc, [campo])).qReturn.qHandle;
      // valores: texto ou {texto, num} (campos duais, como Mês/Ano, exigem o número)
      const r = await call('SelectValues', f, [valores.map(v => typeof v === 'object' && !isNaN(v.num) ? { qText: v.texto, qIsNumeric: true, qNumber: v.num } : { qText: String(typeof v === 'object' ? v.texto : v) }), false, false]);
      if (!r.qReturn) throw new Error(`Não foi possível selecionar ${campo}.`);
      const lst = await this.valores(campo, true);
      if (!lst.length) throw new Error(`Valor não encontrado no campo ${campo}: ${valores.map(v => v.texto || v).join(', ')}.`);
    },
    async valores(campo, soSelecionados = false) {
      const o = (await call('CreateSessionObject', doc, [{ qInfo: { qType: 'lb' }, qListObjectDef: { qDef: { qFieldDefs: [campo] }, qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 1, qHeight: 5000 }] } }])).qReturn.qHandle;
      const l = (await call('GetLayout', o)).qLayout.qListObject.qDataPages[0].qMatrix.map(r => r[0]);
      return l.filter(c => !soSelecionados || c.qState === 'S').map(c => ({ texto: c.qText, num: c.qNum }));
    },
    // Hipercubo: dimensões (expressões de campo) e medidas; devolve linhas [{d:[...], n:[...]}]
    async cubo(dims, medidas) {
      const largura = dims.length + medidas.length;
      const def = {
        qInfo: { qType: 'hc' },
        qHyperCubeDef: {
          qDimensions: dims.map(d => ({ qDef: { qFieldDefs: [d] }, qNullSuppression: false })),
          qMeasures: medidas.map(m => ({ qDef: { qDef: m } })),
          qSuppressZero: true,
          qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: largura, qHeight: Math.floor(10000 / largura) }],
        },
      };
      const o = (await call('CreateSessionObject', doc, [def])).qReturn.qHandle;
      const hc = (await call('GetLayout', o)).qLayout.qHyperCube;
      let linhas = hc.qDataPages[0].qMatrix;
      const altura = Math.floor(10000 / largura);
      for (let top = linhas.length; top < hc.qSize.qcy; top += altura) {
        const p = await call('GetHyperCubeData', o, ['/qHyperCubeDef', [{ qTop: top, qLeft: 0, qWidth: largura, qHeight: altura }]]);
        linhas = linhas.concat(p.qDataPages[0].qMatrix);
      }
      return linhas.map(r => ({ d: r.slice(0, dims.length).map(c => ({ t: c.qIsNull ? null : c.qText, n: c.qNum })), n: r.slice(dims.length).map(c => c.qNum) }));
    },
    async avaliar(expr) { return (await call('Evaluate', doc, [expr])).qReturn; },
    fechar() { try { ws.close(); } catch { } },
  };
}

// Converte número serial do Qlik (dias desde 30/12/1899) em 'AAAA-MM-DD'
const serialParaISO = n => new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
// Data de uma célula de dimensão: usa o número serial ou interpreta textos como "1/out/2026" ou "01/10/2026"
function dataCelula(c) {
  if (!isNaN(c.n) && c.n > 30000) return serialParaISO(c.n);
  const m = String(c.t || '').match(/^(\d{1,2})\/(\w{3}|\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const mes = isNaN(m[2]) ? MESES.indexOf(m[2].toLowerCase()) + 1 : Number(m[2]);
  return mes > 0 ? `${m[3]}-${String(mes).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

// ---------- Coleta PJe ----------

async function coletarPJe() {
  const s = await abrirSessao(CONFIG.pje.appId);
  try {
    for (const [c, v] of Object.entries(CONFIG.pje.selecoes)) await s.selecionar(c, [v]);
    // Fatos diários: mesma base dos indicadores do painel (Count(Processo) por Métrica)
    const fatos = (await s.cubo(['Cod_data', 'Métrica', 'Magistrado', 'Sistema'], ['Count(Processo)']))
      .filter(r => r.d[1].t)
      .map(r => ({
        data: dataCelula(r.d[0]),
        metrica: r.d[1].t,
        magistrado: (r.d[2].t || '').trim() || '(não informado)',
        subsistema: r.d[3].t || 'PJe',
        qtd: r.n[0],
      }));
    // Painel original: "Migrado" das Saídas = count(Processo_EPROC_Migrado) (sem data associada)
    const migrados = Number((await s.avaliar("count(Processo_EPROC_Migrado)")).replace(/\D/g, '')) || 0;
    const meses = (await s.cubo(['Mês/Ano Métrica'], ['Count(Processo)'])).map(r => ({ mes: r.d[0].t, qtd: r.n[0] }));
    const atualizacao = await s.avaliar('vReloadTime_OPEROSIDADE_GERAL');
    return { sistema: 'PJe', painel: CONFIG.pje.painel, selecoes: CONFIG.pje.selecoes, atualizacaoQlik: atualizacao, mesesNaBase: meses, migradosParaEproc: migrados, fatos };
  } finally { s.fechar(); }
}

// ---------- Coleta eProc ----------

async function coletarEproc() {
  const s = await abrirSessao(CONFIG.eproc.appId);
  try {
    for (const [c, v] of Object.entries(CONFIG.eproc.selecoes)) await s.selecionar(c, [v]);
    // Mês corrente no formato do app ("2026/out"); se ainda não houver dados, usa o último mês disponível
    const hoje = new Date();
    const alvo = `${hoje.getFullYear()}/${MESES[hoje.getMonth()]}`;
    const meses = (await s.valores('Mês/Ano Métrica_EPROC')).sort((a, b) => a.num - b.num);
    const mesSel = meses.find(m => m.texto === alvo) || meses[meses.length - 1];
    const mes = mesSel.texto;

    // Histórico mensal da unidade (ignora seleção de mês), como os gráficos de linha do painel
    const hist = (await s.cubo(['Mês/Ano Métrica_EPROC', 'Métrica_EPROC'], ['Count(1)']))
      .filter(r => r.d[1].t)
      .map(r => ({ mes: r.d[0].t, ord: r.d[0].n, metrica: r.d[1].t, qtd: r.n[0] }));

    // Acervo: conforme a observação do painel ("sem necessidade de filtro por Ano ou Mês"),
    // é calculado apenas com a unidade selecionada, antes da seleção do mês
    const acervo = Number((await s.avaliar("Count({<[ACERVO] = {'1'}>} DISTINCT Processo_EPROC)")).replace(/\D/g, '')) || 0;

    await s.selecionar('Mês/Ano Métrica_EPROC', [mesSel]);
    // Fatos diários do mês: mesma base da tabela dinâmica do painel (Count(1) por Métrica_EPROC)
    const fatos = (await s.cubo(['Cod_data_EPROC', 'Métrica_EPROC', 'Magistrado_EPROC'], ['Count(1)']))
      .filter(r => r.d[1].t)
      .map(r => ({
        data: dataCelula(r.d[0]),
        metrica: r.d[1].t,
        magistrado: (r.d[2].t || '').trim() || '(não informado)',
        subsistema: 'eProc',
        qtd: r.n[0],
      }));
    const atualizacao = await s.avaliar("Date(Floor(vReloadTime_OPEROSIDADE_GERAL), 'DD/MM/YYYY')");
    return { sistema: 'eProc', painel: CONFIG.eproc.painel, selecoes: { ...CONFIG.eproc.selecoes, 'Mês/Ano Métrica_EPROC': mes }, mes, atualizacaoQlik: atualizacao, acervo, historico: hist, fatos };
  } finally { s.fechar(); }
}

// ---------- Servidor HTTP ----------

async function dados() {
  const consultadoEm = new Date().toISOString();
  const [pje, eproc] = await Promise.allSettled([coletarPJe(), coletarEproc()]);
  const r = {
    consultadoEm,
    pje: pje.status === 'fulfilled' ? { ok: true, ...pje.value } : { ok: false, erro: pje.reason.message },
    eproc: eproc.status === 'fulfilled' ? { ok: true, ...eproc.value } : { ok: false, erro: eproc.reason.message },
  };
  // Guarda a última consulta bem-sucedida de cada sistema para uso (sinalizado) se o Qlik ficar indisponível
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { }
  for (const k of ['pje', 'eproc']) {
    if (r[k].ok) cache[k] = { ...r[k], consultadoEm };
    else if (cache[k]) r[k].ultimaConsultaValida = cache[k];
  }
  try { fs.writeFileSync(CACHE, JSON.stringify(cache)); } catch { }
  return r;
}

// Reaproveita a última consulta por CONFIG.cacheMs e junta pedidos simultâneos numa só consulta ao Qlik
let memo = null, emAndamento = null;
async function dadosComCache() {
  if (memo && Date.now() - memo.em < CONFIG.cacheMs) return memo.r;
  emAndamento ??= dados().then(r => { memo = { r, em: Date.now() }; return r; }).finally(() => { emAndamento = null; });
  return emAndamento;
}

if (require.main === module) http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  // verificação de funcionamento usada pelo serviço de hospedagem (não consulta o Qlik)
  if (req.url === '/saude') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  try {
    if (req.url.startsWith('/api/dados')) {
      const body = JSON.stringify(await dadosComCache());
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html')));
    }
    // arte do cabeçalho (único arquivo estático servido)
    if (req.url.split('?')[0] === '/banner.webp' && fs.existsSync(path.join(__dirname, 'banner.webp'))) {
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' });
      return res.end(fs.readFileSync(path.join(__dirname, 'banner.webp')));
    }
    res.writeHead(404); res.end();
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ erro: e.message }));
  }
}).listen(CONFIG.porta, CONFIG.host, () => {
  const url = `http://localhost:${CONFIG.porta}`;
  console.log(`Dashboard disponível em ${url}  (Ctrl+C para encerrar)`);
  console.log(`Consulta ao Qlik reaproveitada por ${CONFIG.cacheMs / 60000} min.`);
  if (process.argv.includes('--abrir')) require('child_process').exec(`start "" "${url}"`);
}).on('error', e => {
  if (e.code !== 'EADDRINUSE') throw e;
  // Já existe um servidor do dashboard aberto: apenas abre o navegador nele
  const url = `http://localhost:${CONFIG.porta}`;
  console.log(`O dashboard já está em execução em ${url}. Esta janela pode ser fechada.`);
  if (process.argv.includes('--abrir')) require('child_process').exec(`start "" "${url}"`);
});

module.exports = { dados };
