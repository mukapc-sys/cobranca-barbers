CREATE TABLE IF NOT EXISTS clientes (
  id          TEXT PRIMARY KEY,
  nome        TEXT NOT NULL,
  contato     TEXT,
  chave       TEXT NOT NULL UNIQUE,
  ativo       INTEGER NOT NULL DEFAULT 1,
  criado_em   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS cobrancas (
  id            TEXT PRIMARY KEY,
  cliente_id    TEXT NOT NULL,
  titulo        TEXT NOT NULL,
  descricao     TEXT,
  valor         REAL NOT NULL,
  vencimento    TEXT NOT NULL,
  avisar_dias   INTEGER NOT NULL DEFAULT 3,
  status        TEXT NOT NULL DEFAULT 'aberta',
  mp_pagamento_id TEXT,
  mp_qr_base64    TEXT,
  mp_copia_cola   TEXT,
  mp_expira_em    TEXT,
  pago_em       TEXT,
  criado_em     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_cobrancas_cliente ON cobrancas (cliente_id, status);

CREATE INDEX IF NOT EXISTS ix_cobrancas_mp ON cobrancas (mp_pagamento_id);

CREATE TABLE IF NOT EXISTS eventos_mp (
  id        TEXT PRIMARY KEY,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
