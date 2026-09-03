// ============================================================================
// PAINEL DE COBRANÇAS DO DESENVOLVEDOR
//
// Roda na SUA conta Cloudflare. O token do Mercado Pago fica aqui e nunca sai
// daqui — o sistema do cliente só pergunta "devo alguma coisa?" e recebe a
// resposta pronta, com o QR já gerado.
//
// Isso significa que:
//   - suas credenciais não moram na infra de nenhum cliente
//   - um cliente novo é uma linha na tabela, não um deploy
//   - o mesmo painel serve todos os seus projetos
//
// SEGREDOS (Settings > Variables and Secrets)
//   MP_ACCESS_TOKEN   token do Mercado Pago (o seu)
//   ADMIN_SENHA       a senha do painel
//   ADMIN_JWT         qualquer texto longo, para assinar a sessão
// ============================================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
}

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
  })

const erro = (msg, status = 400) => json({ erro: msg }, status)

const id = () => crypto.randomUUID().slice(0, 18)
const hojeBR = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10)

function diasAte (data) {
  const a = new Date(hojeBR() + 'T12:00:00Z')
  const b = new Date(String(data).slice(0, 10) + 'T12:00:00Z')
  return Math.round((b - a) / 86400000)
}

// ---------------------------------------------------------------- sessão ---

// Token simples e assinado. Não usa biblioteca: o painel tem um usuário só.
async function assinar (texto, segredo) {
  const chave = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(segredo),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const bytes = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(texto))
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/[+/=]/g, '')
}

async function criarSessao (env) {
  const validade = Date.now() + 12 * 3600 * 1000
  return validade + '.' + await assinar(String(validade), env.ADMIN_JWT || 'sem-segredo')
}

async function sessaoValida (req, env) {
  const cab = req.headers.get('Authorization') || ''
  const token = cab.replace(/^Bearer\s+/i, '')
  const [validade, assinatura] = token.split('.')
  if (!validade || !assinatura) return false
  if (Number(validade) < Date.now()) return false
  return assinatura === await assinar(validade, env.ADMIN_JWT || 'sem-segredo')
}

// ----------------------------------------------------------- Mercado Pago --

// Cria a cobrança Pix e devolve o QR pronto para a tela.
async function gerarPix (env, { valor, descricao, referencia, email }) {
  const r = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.MP_ACCESS_TOKEN,
      'Content-Type': 'application/json',
      // O MP recusa o pedido repetido quando a chave é a mesma. Como cada
      // cobrança gera o Pix uma vez só, a referência serve bem.
      'X-Idempotency-Key': 'cob-' + referencia
    },
    body: JSON.stringify({
      transaction_amount: Number(valor),
      description: String(descricao || 'Cobrança').slice(0, 250),
      payment_method_id: 'pix',
      external_reference: referencia,
      payer: { email: email || 'pagador@exemplo.com' }
    })
  })
  const dados = await r.json().catch(() => null)
  if (!r.ok) {
    const msg = (dados && (dados.message || dados.error)) || ('Mercado Pago respondeu ' + r.status)
    throw new Error(msg)
  }
  const tx = (dados.point_of_interaction && dados.point_of_interaction.transaction_data) || {}
  return {
    pagamento_id: String(dados.id),
    qr_base64: tx.qr_code_base64 || null,
    copia_cola: tx.qr_code || null,
    expira_em: dados.date_of_expiration || null
  }
}

async function verPagamento (env, pagamentoId) {
  const r = await fetch('https://api.mercadopago.com/v1/payments/' + pagamentoId, {
    headers: { 'Authorization': 'Bearer ' + env.MP_ACCESS_TOKEN }
  })
  if (!r.ok) return null
  return r.json().catch(() => null)
}

// ------------------------------------------------------------------ rotas --

export default {
  async fetch (req, env) {
    const url = new URL(req.url)
    const rota = url.pathname.replace(/\/$/, '') || '/'
    const metodo = req.method

    if (metodo === 'OPTIONS') return new Response(null, { headers: CORS })
    if (rota === '/health') return json({ ok: true, painel: 'cobrancas' })

    const db = env.DB
    let corpo = {}
    if (metodo !== 'GET') { try { corpo = await req.json() } catch (e) { corpo = {} } }

    try {
      // ==========================================================
      // O SISTEMA DO CLIENTE PERGUNTA
      // ==========================================================

      // GET /api/pendencias?chave=XXX
      // Devolve só o que o cliente precisa mostrar HOJE. Cobrança longe do
      // vencimento nem aparece — o banner só existe quando é hora de avisar.
      if (rota === '/api/pendencias' && metodo === 'GET') {
        const chave = url.searchParams.get('chave') || ''
        if (!chave) return erro('Informe a chave', 401)

        const cli = await db.prepare('SELECT id, nome FROM clientes WHERE chave = ? AND ativo = 1')
          .bind(chave).first()
        if (!cli) return erro('Chave não reconhecida', 401)

        const { results } = await db.prepare(
          `SELECT id, titulo, descricao, valor, vencimento, avisar_dias
             FROM cobrancas
            WHERE cliente_id = ? AND status = 'aberta'
            ORDER BY vencimento`
        ).bind(cli.id).all()

        const mostrar = (results || [])
          .map(c => ({ ...c, dias: diasAte(c.vencimento) }))
          .filter(c => c.dias <= (c.avisar_dias || 3))
          .map(c => ({
            id: c.id,
            titulo: c.titulo,
            descricao: c.descricao,
            valor: c.valor,
            vencimento: c.vencimento,
            dias: c.dias,
            vencida: c.dias < 0
          }))

        return json({ cliente: cli.nome, cobrancas: mostrar })
      }

      // POST /api/cobranca/:id/pix — gera (ou devolve) o Pix
      if (/^\/api\/cobranca\/[^/]+\/pix$/.test(rota) && metodo === 'POST') {
        const cobId = rota.split('/')[3]
        const chave = corpo.chave || url.searchParams.get('chave') || ''
        const cob = await db.prepare(
          `SELECT c.*, cl.chave, cl.nome AS cliente_nome
             FROM cobrancas c JOIN clientes cl ON cl.id = c.cliente_id
            WHERE c.id = ?`
        ).bind(cobId).first()
        if (!cob) return erro('Cobrança não encontrada', 404)
        if (cob.chave !== chave) return erro('Chave não confere', 403)
        if (cob.status === 'paga') return json({ ja_paga: true })

        // Já existe um Pix válido? Devolve o mesmo, em vez de criar outro.
        if (cob.mp_copia_cola && (!cob.mp_expira_em || new Date(cob.mp_expira_em) > new Date())) {
          return json({
            qr_base64: cob.mp_qr_base64,
            copia_cola: cob.mp_copia_cola,
            expira_em: cob.mp_expira_em,
            valor: cob.valor
          })
        }

        if (!env.MP_ACCESS_TOKEN) return erro('Pagamento online indisponível no momento.', 503)

        const pix = await gerarPix(env, {
          valor: cob.valor,
          descricao: cob.titulo,
          referencia: cob.id,
          email: 'pagador@exemplo.com'
        })
        await db.prepare(
          `UPDATE cobrancas SET mp_pagamento_id = ?, mp_qr_base64 = ?, mp_copia_cola = ?, mp_expira_em = ?
            WHERE id = ?`
        ).bind(pix.pagamento_id, pix.qr_base64, pix.copia_cola, pix.expira_em, cob.id).run()

        return json({
          qr_base64: pix.qr_base64,
          copia_cola: pix.copia_cola,
          expira_em: pix.expira_em,
          valor: cob.valor
        })
      }

      // GET /api/cobranca/:id/status — o app pergunta se o Pix caiu
      if (/^\/api\/cobranca\/[^/]+\/status$/.test(rota) && metodo === 'GET') {
        const cobId = rota.split('/')[3]
        const chave = url.searchParams.get('chave') || ''
        const cob = await db.prepare(
          `SELECT c.status, c.mp_pagamento_id, cl.chave
             FROM cobrancas c JOIN clientes cl ON cl.id = c.cliente_id
            WHERE c.id = ?`
        ).bind(cobId).first()
        if (!cob) return erro('Cobrança não encontrada', 404)
        if (cob.chave !== chave) return erro('Chave não confere', 403)
        if (cob.status === 'paga') return json({ paga: true })

        // Consulta o MP direto: o webhook pode demorar, e quem está com o QR
        // aberto na tela quer a confirmação na hora.
        if (cob.mp_pagamento_id && env.MP_ACCESS_TOKEN) {
          const p = await verPagamento(env, cob.mp_pagamento_id)
          if (p && p.status === 'approved') {
            await db.prepare("UPDATE cobrancas SET status='paga', pago_em=? WHERE id=?")
              .bind(new Date().toISOString(), cobId).run()
            return json({ paga: true })
          }
        }
        return json({ paga: false })
      }

      // ==========================================================
      // MERCADO PAGO AVISA
      // ==========================================================
      if (rota === '/webhook/mp' && metodo === 'POST') {
        // Responde 200 mesmo com erro: o MP para de enviar depois de várias
        // falhas, e uma fila parada perde avisos.
        try {
          const tipo = corpo.type || corpo.topic
          const pagamentoId = (corpo.data && corpo.data.id) || corpo['data.id']
          if (tipo !== 'payment' || !pagamentoId) return json({ recebido: true, ignorado: true })

          const eventoId = 'mp-' + pagamentoId + '-' + (corpo.action || '')
          const repetido = await db.prepare('SELECT id FROM eventos_mp WHERE id = ?').bind(eventoId).first()
          if (repetido) return json({ recebido: true, repetido: true })
          await db.prepare('INSERT INTO eventos_mp (id) VALUES (?)').bind(eventoId).run()

          const p = await verPagamento(env, pagamentoId)
          if (p && p.status === 'approved' && p.external_reference) {
            await db.prepare("UPDATE cobrancas SET status='paga', pago_em=? WHERE id=? AND status<>'paga'")
              .bind(new Date().toISOString(), p.external_reference).run()
          }
          return json({ recebido: true })
        } catch (e) {
          return json({ recebido: true, erro: e.message })
        }
      }

      // ==========================================================
      // PAINEL — só você
      // ==========================================================
      if (rota === '/admin/login' && metodo === 'POST') {
        if (!env.ADMIN_SENHA) return erro('Painel sem senha configurada', 503)
        if (String(corpo.senha || '') !== env.ADMIN_SENHA) return erro('Senha incorreta', 401)
        return json({ token: await criarSessao(env) })
      }

      if (rota.startsWith('/admin/')) {
        if (!await sessaoValida(req, env)) return erro('Sessão expirada. Entre de novo.', 401)
      }

      // ---- clientes ----
      if (rota === '/admin/clientes' && metodo === 'GET') {
        const { results } = await db.prepare(
          `SELECT c.*, (SELECT COUNT(*) FROM cobrancas WHERE cliente_id = c.id AND status = 'aberta') AS abertas
             FROM clientes c ORDER BY c.nome`
        ).all()
        return json(results || [])
      }

      if (rota === '/admin/clientes' && metodo === 'POST') {
        const nome = String(corpo.nome || '').trim()
        if (!nome) return erro('Informe o nome do cliente')
        const novo = {
          id: id(),
          nome,
          contato: corpo.contato || null,
          // A chave é o que o sistema do cliente usa para se identificar.
          // Gerada aqui para você não precisar inventar uma.
          chave: 'cli_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)
        }
        await db.prepare('INSERT INTO clientes (id, nome, contato, chave) VALUES (?,?,?,?)')
          .bind(novo.id, novo.nome, novo.contato, novo.chave).run()
        return json(novo, 201)
      }

      if (/^\/admin\/clientes\/[^/]+$/.test(rota) && metodo === 'DELETE') {
        const cid = rota.split('/')[3]
        const pagas = await db.prepare("SELECT id FROM cobrancas WHERE cliente_id=? AND status='paga' LIMIT 1")
          .bind(cid).first()
        if (pagas) return erro('Este cliente já tem pagamento registrado e não pode ser apagado. Desative em vez disso.', 409)
        await db.prepare('DELETE FROM cobrancas WHERE cliente_id = ?').bind(cid).run()
        await db.prepare('DELETE FROM clientes WHERE id = ?').bind(cid).run()
        return json({ ok: true })
      }

      // ---- cobranças ----
      if (rota === '/admin/cobrancas' && metodo === 'GET') {
        const filtro = url.searchParams.get('cliente_id')
        const sql = `SELECT c.*, cl.nome AS cliente_nome FROM cobrancas c
                       JOIN clientes cl ON cl.id = c.cliente_id
                      ${filtro ? 'WHERE c.cliente_id = ?' : ''}
                      ORDER BY c.status = 'paga', c.vencimento`
        const st = filtro ? db.prepare(sql).bind(filtro) : db.prepare(sql)
        const { results } = await st.all()
        return json((results || []).map(c => ({ ...c, dias: diasAte(c.vencimento) })))
      }

      if (rota === '/admin/cobrancas' && metodo === 'POST') {
        const { cliente_id, titulo, descricao, valor, vencimento, avisar_dias } = corpo
        if (!cliente_id) return erro('Escolha o cliente')
        if (!titulo || !String(titulo).trim()) return erro('Informe o título')
        const v = Number(valor)
        if (!v || v <= 0) return erro('Informe um valor maior que zero')
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(vencimento || ''))) return erro('Informe a data de vencimento')

        const nova = {
          id: id(),
          cliente_id,
          titulo: String(titulo).trim(),
          descricao: descricao ? String(descricao).trim() : null,
          valor: v,
          vencimento: String(vencimento).slice(0, 10),
          avisar_dias: parseInt(avisar_dias, 10) || 3
        }
        await db.prepare(
          `INSERT INTO cobrancas (id, cliente_id, titulo, descricao, valor, vencimento, avisar_dias)
           VALUES (?,?,?,?,?,?,?)`
        ).bind(nova.id, nova.cliente_id, nova.titulo, nova.descricao, nova.valor, nova.vencimento, nova.avisar_dias).run()
        return json(nova, 201)
      }

      // Baixa manual: o cliente pagou por fora (transferência, dinheiro).
      if (/^\/admin\/cobrancas\/[^/]+\/baixar$/.test(rota) && metodo === 'POST') {
        const cid = rota.split('/')[3]
        await db.prepare("UPDATE cobrancas SET status='paga', pago_em=? WHERE id=?")
          .bind(new Date().toISOString(), cid).run()
        return json({ ok: true })
      }

      if (/^\/admin\/cobrancas\/[^/]+$/.test(rota) && metodo === 'DELETE') {
        const cid = rota.split('/')[3]
        const cob = await db.prepare('SELECT status FROM cobrancas WHERE id = ?').bind(cid).first()
        if (!cob) return erro('Cobrança não encontrada', 404)
        if (cob.status === 'paga') {
          return erro('Esta cobrança já foi paga e não pode ser apagada — o registro se perderia.', 409)
        }
        await db.prepare('DELETE FROM cobrancas WHERE id = ?').bind(cid).run()
        return json({ ok: true })
      }

      return erro('Rota não encontrada: ' + rota, 404)
    } catch (e) {
      return erro('Erro no servidor: ' + (e.message || ''), 500)
    }
  }
}
