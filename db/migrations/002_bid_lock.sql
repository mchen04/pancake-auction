CREATE OR REPLACE FUNCTION increasing_bid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM lots WHERE id = NEW.lot_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM bids WHERE lot_id = NEW.lot_id AND amount >= NEW.amount) THEN
    RAISE EXCEPTION 'bid must increase' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
