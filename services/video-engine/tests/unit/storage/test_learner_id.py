"""
learner_id pass-through: sessions column, store round-trip, list filter,
and the ALTER TABLE migration for pre-existing databases.
"""
import sqlite3

import pytest

from math_tutor.infrastructure.storage.conversation_store import ConversationStore
from math_tutor.infrastructure.storage.database import Database
from math_tutor.infrastructure.storage.file_archive import FileArchive


@pytest.fixture
def store(tmp_path):
    db = Database(tmp_path / "test.sqlite")
    archive = FileArchive(tmp_path / "data")
    return ConversationStore(db, archive)


class TestLearnerIdRoundTrip:
    async def test_create_read_roundtrip(self, store):
        sid = await store.create_session("1+1=?", "elementary_upper", learner_id="stu-42")
        session = await store.get_session(sid)
        assert session is not None
        assert session.learner_id == "stu-42"

    async def test_default_is_none(self, store):
        sid = await store.create_session("1+1=?", "elementary_upper")
        session = await store.get_session(sid)
        assert session.learner_id is None

    async def test_list_filter_by_learner(self, store):
        a1 = await store.create_session("p1", "elementary_upper", learner_id="alice")
        a2 = await store.create_session("p2", "elementary_upper", learner_id="alice")
        b1 = await store.create_session("p3", "elementary_upper", learner_id="bob")
        await store.create_session("p4", "elementary_upper")  # anonymous

        alice = await store.list_sessions(learner_id="alice")
        assert {s.id for s in alice} == {a1, a2}
        assert all(s.learner_id == "alice" for s in alice)

        bob = await store.list_sessions(learner_id="bob")
        assert [s.id for s in bob] == [b1]

        everyone = await store.list_sessions()
        assert len(everyone) == 4

    async def test_list_filter_combines_with_label(self, store):
        s1 = await store.create_session("p1", "elementary_upper", learner_id="alice")
        s2 = await store.create_session("p2", "elementary_upper", learner_id="bob")
        await store.add_feedback(s1, "good")
        await store.add_feedback(s2, "good")

        rows = await store.list_sessions(label="good", learner_id="alice")
        assert [s.id for s in rows] == [s1]


class TestLegacyDbMigration:
    def _make_legacy_db(self, path):
        """A sessions table from before the learner_id column existed."""
        conn = sqlite3.connect(path)
        conn.execute(
            """
            CREATE TABLE sessions (
                id               TEXT PRIMARY KEY,
                created_at       TEXT NOT NULL,
                updated_at       TEXT NOT NULL,
                problem          TEXT NOT NULL,
                grade            TEXT NOT NULL,
                status           TEXT NOT NULL,
                final_video_path TEXT,
                error            TEXT,
                meta_json        TEXT
            )
            """
        )
        conn.execute(
            "INSERT INTO sessions VALUES ('old-1', '2026-01-01T00:00:00+00:00',"
            " '2026-01-01T00:00:00+00:00', 'legacy problem', 'elementary_upper',"
            " 'done', NULL, NULL, '{}')"
        )
        conn.commit()
        conn.close()

    async def test_old_db_without_column_migrates(self, tmp_path):
        db_path = tmp_path / "legacy.sqlite"
        self._make_legacy_db(db_path)

        db = Database(db_path)  # must not raise; adds the column
        cols = {
            row["name"]
            for row in db.fetch_all_sync("SELECT name FROM pragma_table_info('sessions')")
        }
        assert "learner_id" in cols

        store = ConversationStore(db, FileArchive(tmp_path / "data"))
        legacy = await store.get_session("old-1")
        assert legacy is not None
        assert legacy.learner_id is None

        # New writes on the migrated DB carry the learner through.
        sid = await store.create_session("new", "elementary_upper", learner_id="carol")
        rows = await store.list_sessions(learner_id="carol")
        assert [s.id for s in rows] == [sid]

    def test_reopening_migrated_db_is_idempotent(self, tmp_path):
        db_path = tmp_path / "legacy.sqlite"
        self._make_legacy_db(db_path)
        Database(db_path)
        # Second open must skip the ALTER without raising.
        db = Database(db_path)
        cols = {
            row["name"]
            for row in db.fetch_all_sync("SELECT name FROM pragma_table_info('sessions')")
        }
        assert "learner_id" in cols
