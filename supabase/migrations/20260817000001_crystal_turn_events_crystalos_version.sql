-- Provenance-stamp crystal_turn_events with the CrystalOS build that produced
-- the turn (lib/turn_publisher.py's TurnEvent.crystalos_version, sourced from
-- lib/constants.py's CRYSTALOS_VERSION). Nullable text column — fully backward
-- compatible with rows written before this field existed and with any caller
-- that doesn't set it.
--
-- NOTE: per project convention, migrations here are written/reviewed but not
-- run against any live database as part of this change.

ALTER TABLE crystal_turn_events
    ADD COLUMN IF NOT EXISTS crystalos_version TEXT;

COMMENT ON COLUMN crystal_turn_events.crystalos_version IS 'CrystalOS build/version that produced this turn (crystalos.lib.constants.CRYSTALOS_VERSION); NULL for turns recorded before this field existed';
