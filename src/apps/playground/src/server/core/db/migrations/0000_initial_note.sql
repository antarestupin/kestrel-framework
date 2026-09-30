-- Creates the initial application note table as the first deployment migration.
-- Preserve applied migration history and generate new migrations for subsequent schema changes.

CREATE TABLE "note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL
);
