CREATE TABLE draft (
  id integer PRIMARY KEY CHECK (id = 1),
  status text NOT NULL DEFAULT 'setup' CHECK (status IN ('setup','running','paused','complete')),
  phase text NOT NULL DEFAULT 'nomination' CHECK (phase IN ('nomination','bidding')),
  nomination_order integer[] NOT NULL DEFAULT '{}',
  turn_index integer NOT NULL DEFAULT 0,
  nominator_id integer,
  lot_id integer,
  deadline timestamptz,
  remaining_ms double precision,
  nomination_ms integer NOT NULL DEFAULT 10000 CHECK (nomination_ms > 0),
  bidding_ms integer NOT NULL DEFAULT 10000 CHECK (bidding_ms > 0),
  extension_ms integer NOT NULL DEFAULT 5000 CHECK (extension_ms > 0),
  cap_ms integer NOT NULL DEFAULT 15000 CHECK (cap_ms > 0)
);
INSERT INTO draft(id) VALUES(1);
CREATE TABLE managers (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  commissioner boolean NOT NULL DEFAULT false,
  budget integer NOT NULL DEFAULT 1000 CHECK (budget BETWEEN 0 AND 1000),
  done boolean NOT NULL DEFAULT false,
  token_hash text UNIQUE,
  claimed_at timestamptz
);
CREATE UNIQUE INDEX one_commissioner ON managers(commissioner) WHERE commissioner;
CREATE TABLE players (
  id text PRIMARY KEY,
  data jsonb NOT NULL
);
CREATE TABLE lots (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id),
  nominator_id integer NOT NULL REFERENCES managers(id),
  high_bidder_id integer NOT NULL REFERENCES managers(id),
  high_bid integer NOT NULL CHECK (high_bid >= 1),
  status text NOT NULL CHECK (status IN ('open','sold','void','undone')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sold_at timestamptz
);
CREATE UNIQUE INDEX one_open_lot ON lots(status) WHERE status = 'open';
CREATE UNIQUE INDEX player_sold_once ON lots(player_id) WHERE status = 'sold';
CREATE TABLE bids (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lot_id integer NOT NULL REFERENCES lots(id),
  manager_id integer NOT NULL REFERENCES managers(id),
  amount integer NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(lot_id,amount)
);
CREATE FUNCTION increasing_bid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM bids WHERE lot_id = NEW.lot_id AND amount >= NEW.amount) THEN
    RAISE EXCEPTION 'bid must increase' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER increasing_bid BEFORE INSERT ON bids FOR EACH ROW EXECUTE FUNCTION increasing_bid();
CREATE TABLE passes (
  lot_id integer NOT NULL REFERENCES lots(id),
  manager_id integer NOT NULL REFERENCES managers(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(lot_id,manager_id)
);
CREATE TABLE roster (
  player_id text PRIMARY KEY REFERENCES players(id),
  manager_id integer NOT NULL REFERENCES managers(id),
  placement text NOT NULL CHECK (placement IN ('active','taxi','ir')),
  price integer NOT NULL CHECK (price > 0),
  lot_id integer NOT NULL UNIQUE REFERENCES lots(id)
);
CREATE TABLE events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type text NOT NULL,
  manager_id integer REFERENCES managers(id),
  lot_id integer REFERENCES lots(id),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION immutable_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events are append only';
END;
$$;
CREATE TRIGGER immutable_event BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION immutable_event();
CREATE TABLE import_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sources jsonb NOT NULL,
  counts jsonb NOT NULL,
  coverage jsonb NOT NULL
);
