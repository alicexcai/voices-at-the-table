import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

export const pool = new Pool({
  connectionString: databaseUrl,
  max: 5
});

export async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.anonymous_survey_drafts (
        id uuid PRIMARY KEY,
        edit_token_hash text NOT NULL UNIQUE,
        recording_consent boolean NOT NULL DEFAULT false,
        industry text,
        role text,
        occupation text,
        city text,
        display_name text,
        is_anonymous boolean NOT NULL DEFAULT true,
        contact_email text,
        contact_phone text,
        answers jsonb NOT NULL DEFAULT '{}'::jsonb,
        roundtable_interest boolean NOT NULL DEFAULT false,
        use_voice_in_roundtable boolean NOT NULL DEFAULT false,
        contact_me boolean NOT NULL DEFAULT false,
        current_step integer NOT NULL DEFAULT 0,
        completed_through integer NOT NULL DEFAULT -1,
        publish_to_wall boolean NOT NULL DEFAULT false,
        submitted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.anonymous_survey_audio (
        id uuid PRIMARY KEY,
        draft_id uuid NOT NULL REFERENCES public.anonymous_survey_drafts(id) ON DELETE CASCADE,
        question_id text NOT NULL,
        object_key text NOT NULL,
        audio_mime_type text NOT NULL,
        duration_seconds integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (draft_id, question_id)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS anonymous_survey_drafts_published_idx
      ON public.anonymous_survey_drafts (submitted_at DESC)
      WHERE submitted_at IS NOT NULL AND publish_to_wall = true
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
