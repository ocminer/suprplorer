-- NEB explorer index (database explorer_neb). Amounts are base units (1 NEB = 10^8).
-- Every table that depends on a block carries its height, so a reorg deletes by height.

CREATE TABLE IF NOT EXISTS meta (
  k VARCHAR(64) PRIMARY KEY,
  v VARCHAR(255) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS blocks (
  height        INT UNSIGNED PRIMARY KEY,
  hash          BINARY(32) NOT NULL,
  parent        BINARY(32) NOT NULL,
  version       INT UNSIGNED NOT NULL,
  time          INT UNSIGNED NOT NULL,
  bits          INT UNSIGNED NOT NULL,
  nonce         INT UNSIGNED NOT NULL,
  body_root     BINARY(32) NOT NULL,
  size          INT UNSIGNED NOT NULL,
  tx_count      INT UNSIGNED NOT NULL,
  share_count   SMALLINT UNSIGNED NOT NULL,
  difficulty    DOUBLE NOT NULL,              -- genesis target / target
  chainwork     VARCHAR(80) NOT NULL,         -- decimal string, can exceed DECIMAL(65)
  reward        BIGINT UNSIGNED NOT NULL,     -- subsidy of the height (genesis: whole coinbase)
  fees          BIGINT UNSIGNED NOT NULL,
  coinbase_out  BIGINT UNSIGNED NOT NULL,
  destroyed     BIGINT UNSIGNED NOT NULL,     -- reward + fees - coinbase_out
  volume        BIGINT UNSIGNED NOT NULL,     -- sum of non-coinbase outputs
  miner_address_id BIGINT UNSIGNED NULL,      -- first coinbase output
  coinbase_witness VARBINARY(512) NOT NULL,
  supply        BIGINT UNSIGNED NOT NULL,     -- sum of unspent outputs after this block
  utxo_count    BIGINT UNSIGNED NOT NULL,
  address_count BIGINT UNSIGNED NOT NULL,     -- addresses ever seen up to this block
  UNIQUE KEY uk_hash (hash),
  KEY k_time (time),
  KEY k_miner (miner_address_id, height)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS txs (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  txid          BINARY(32) NOT NULL,
  height        INT UNSIGNED NOT NULL,
  idx           INT UNSIGNED NOT NULL,        -- position in block
  time          INT UNSIGNED NOT NULL,
  version       TINYINT UNSIGNED NOT NULL,
  size          INT UNSIGNED NOT NULL,
  is_coinbase   BOOLEAN NOT NULL,
  n_in          SMALLINT UNSIGNED NOT NULL,
  n_out         INT UNSIGNED NOT NULL,
  total_in      BIGINT UNSIGNED NOT NULL,
  total_out     BIGINT UNSIGNED NOT NULL,
  fee           BIGINT UNSIGNED NOT NULL,
  flags         INT UNSIGNED NOT NULL DEFAULT 0, -- forensic flags, see indexer.FLAG_*
  UNIQUE KEY uk_txid (txid),
  UNIQUE KEY uk_pos (height, idx),
  KEY k_total_out (total_out)
) ENGINE=InnoDB;

-- Every output ever created; spent_* NULL means unspent: this table is the UTXO index.
CREATE TABLE IF NOT EXISTS outputs (
  tx_id         BIGINT UNSIGNED NOT NULL,
  n             INT UNSIGNED NOT NULL,
  height        INT UNSIGNED NOT NULL,
  amount        BIGINT UNSIGNED NOT NULL,
  lock_type     TINYINT UNSIGNED NOT NULL,
  address_id    BIGINT UNSIGNED NOT NULL,
  is_coinbase   BOOLEAN NOT NULL,
  spent_tx_id   BIGINT UNSIGNED NULL,
  spent_n       SMALLINT UNSIGNED NULL,
  spent_height  INT UNSIGNED NULL,
  PRIMARY KEY (tx_id, n),
  KEY k_addr_unspent (address_id, spent_height, height),
  KEY k_spent_height (spent_height),
  KEY k_height (height)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS inputs (
  tx_id         BIGINT UNSIGNED NOT NULL,
  n             SMALLINT UNSIGNED NOT NULL,
  height        INT UNSIGNED NOT NULL,
  prev_tx_id    BIGINT UNSIGNED NULL,         -- NULL for the coinbase input
  prev_n        INT UNSIGNED NULL,
  address_id    BIGINT UNSIGNED NULL,
  amount        BIGINT UNSIGNED NOT NULL,
  witness       VARBINARY(2048) NOT NULL,
  PRIMARY KEY (tx_id, n),
  KEY k_prev (prev_tx_id, prev_n),
  KEY k_addr (address_id, height),
  KEY k_height (height)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS addresses (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  lock_type     TINYINT UNSIGNED NOT NULL,
  lock_data     BINARY(32) NOT NULL,
  address       VARCHAR(80) NOT NULL,
  balance       BIGINT NOT NULL DEFAULT 0,
  received      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  sent          BIGINT UNSIGNED NOT NULL DEFAULT 0,
  tx_count      INT UNSIGNED NOT NULL DEFAULT 0,
  utxo_count    INT NOT NULL DEFAULT 0,
  first_height  INT UNSIGNED NOT NULL,
  last_height   INT UNSIGNED NOT NULL,
  pubkey        BINARY(32) NULL,              -- revealed by the first spend (type 1)
  multisig_m    TINYINT UNSIGNED NULL,
  multisig_n    TINYINT UNSIGNED NULL,
  label         VARCHAR(128) NULL,
  cluster_id    BIGINT UNSIGNED NULL,
  UNIQUE KEY uk_lock (lock_type, lock_data),
  UNIQUE KEY uk_address (address),
  KEY k_balance (balance),
  KEY k_received (received),
  KEY k_cluster (cluster_id)
) ENGINE=InnoDB;

-- Per address per transaction: the ledger. balance_after allows statements and balance-at-height queries.
CREATE TABLE IF NOT EXISTS ledger (
  address_id    BIGINT UNSIGNED NOT NULL,
  tx_id         BIGINT UNSIGNED NOT NULL,
  height        INT UNSIGNED NOT NULL,
  received      BIGINT UNSIGNED NOT NULL,
  sent          BIGINT UNSIGNED NOT NULL,
  outs          INT UNSIGNED NOT NULL,        -- outputs to the address
  ins           INT UNSIGNED NOT NULL,        -- inputs from the address
  balance_after BIGINT NOT NULL,
  PRIMARY KEY (address_id, height, tx_id),
  KEY k_tx (tx_id),
  KEY k_height (height)
) ENGINE=InnoDB;

-- Share records listed by each block (spec/shares.md 11.2), for mining forensics.
CREATE TABLE IF NOT EXISTS shares (
  height        INT UNSIGNED NOT NULL,
  idx           SMALLINT UNSIGNED NOT NULL,
  body_root     BINARY(32) NOT NULL,
  time          INT UNSIGNED NOT NULL,
  nonce         INT UNSIGNED NOT NULL,
  PRIMARY KEY (height, idx)
) ENGINE=InnoDB;

-- Forensics: common-input-ownership clusters, rebuilt by clusters.py.
CREATE TABLE IF NOT EXISTS clusters (
  id            BIGINT UNSIGNED PRIMARY KEY,  -- smallest address id of the cluster
  size          INT UNSIGNED NOT NULL,
  balance       BIGINT NOT NULL,
  received      BIGINT UNSIGNED NOT NULL,
  tx_count      INT UNSIGNED NOT NULL,
  first_height  INT UNSIGNED NOT NULL,
  last_height   INT UNSIGNED NOT NULL,
  label         VARCHAR(128) NULL,
  KEY k_balance (balance)
) ENGINE=InnoDB;

-- Ledger calculations per UTC day, rebuilt for the touched days by stats.py.
CREATE TABLE IF NOT EXISTS daily_stats (
  day             DATE PRIMARY KEY,
  blocks          INT UNSIGNED NOT NULL,
  txs             INT UNSIGNED NOT NULL,
  volume          BIGINT UNSIGNED NOT NULL,
  fees            BIGINT UNSIGNED NOT NULL,
  minted          BIGINT UNSIGNED NOT NULL,
  destroyed       BIGINT UNSIGNED NOT NULL,
  new_addresses   INT UNSIGNED NOT NULL,
  active_addresses INT UNSIGNED NOT NULL,
  supply_end      BIGINT UNSIGNED NOT NULL,
  avg_difficulty  DOUBLE NOT NULL,
  avg_block_time  DOUBLE NULL
) ENGINE=InnoDB;

-- Address labels (pools, exchanges, known holders): labels/<coin>.json synced on deploy, plus local CLI labels.
-- Kept apart from addresses so a reorg never removes them; they win over automatic labels.
CREATE TABLE IF NOT EXISTS labels (
  address       VARCHAR(80) PRIMARY KEY,
  label         VARCHAR(128) NOT NULL,
  category      VARCHAR(32) NOT NULL DEFAULT 'other', -- pool, exchange, project, holder, burn, other
  url           VARCHAR(255) NULL,
  fee           DECIMAL(5,2) NULL,                    -- pool fee in percent (labels file)
  miner_fee     DECIMAL(5,2) NULL,                    -- fee of the pool's own miner, percent
  fee_source    VARCHAR(255) NULL,                    -- where the fee is published; NULL = reported, not verified
  note          VARCHAR(255) NULL,
  source        VARCHAR(8) NOT NULL DEFAULT 'local',  -- 'repo' = labels/<coin>.json (suprplorer-label sync), 'local' = CLI
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Neural-network models per block (indexer/model_watch.py): our node's weights hash per slot and block,
-- and the accuracy history the NEB project publishes, verified against those hashes.
CREATE TABLE IF NOT EXISTS model_states (
  slot          TINYINT UNSIGNED NOT NULL,
  height        INT UNSIGNED NOT NULL,
  blockhash     BINARY(32) NOT NULL,
  weights_hash  BINARY(32) NOT NULL,
  dataset       VARCHAR(32) NOT NULL,
  weights       MEDIUMBLOB NULL,             -- packed weights, stored when they changed
  PRIMARY KEY (slot, height)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS model_frames (
  slot          TINYINT UNSIGNED NOT NULL,
  height        INT UNSIGNED NOT NULL,
  steps         SMALLINT UNSIGNED NOT NULL,  -- training steps (shares) applied at this block
  accuracy      DECIMAL(5,1) NOT NULL,       -- percent, on samples the model never trained on
  neurons       BINARY(32) NOT NULL,         -- hidden neuron summary (0-255)
  links         VARBINARY(64) NOT NULL,      -- hidden -> output link weights, offset by 16
  PRIMARY KEY (slot, height)
) ENGINE=InnoDB;
