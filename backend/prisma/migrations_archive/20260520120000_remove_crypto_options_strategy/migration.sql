-- One-time cleanup: remove legacy "Crypto Options …" strategies (and dependents).
-- Future Hedge Strategy is preserved / created separately by application bootstrap.
-- Safe to re-run: deletes only rows matching known legacy titles or "Crypto Options" substring.

DO $$
DECLARE
  strat RECORD;
BEGIN
  FOR strat IN
    SELECT id, title
    FROM "Strategy"
    WHERE title <> 'Future Hedge Strategy'
      AND (
        title IN (
          'Crypto Options Trading - For Delta Ex India',
          'Intraday Cryptotrading Algo - For Delta Ex India'
        )
        OR title ILIKE '%Crypto Options%'
      )
  LOOP
    DELETE FROM "TradePosition" WHERE "strategyId" = strat.id;
    DELETE FROM "Trade" WHERE "strategyId" = strat.id;
    DELETE FROM "Invoice" WHERE "strategyId" = strat.id;
    DELETE FROM "PnLRecord" WHERE "strategyId" = strat.id;
    DELETE FROM "UserSubscription" WHERE "strategyId" = strat.id;
    DELETE FROM "Strategy" WHERE id = strat.id;
    RAISE NOTICE 'Removed legacy strategy "%" (%)', strat.title, strat.id;
  END LOOP;
END $$;
