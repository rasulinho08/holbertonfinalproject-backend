-- CreateEnum
CREATE TYPE "buddy_invitation_status" AS ENUM ('pending', 'accepted', 'declined');

-- CreateTable
CREATE TABLE "buddy_read_invitations" (
    "id" UUID NOT NULL,
    "buddy_read_id" UUID NOT NULL,
    "inviter_id" UUID NOT NULL,
    "invitee_id" UUID NOT NULL,
    "status" "buddy_invitation_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMPTZ(6),

    CONSTRAINT "buddy_read_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "buddy_read_invitations_buddy_read_id_invitee_id_key" ON "buddy_read_invitations"("buddy_read_id", "invitee_id");

-- CreateIndex
CREATE INDEX "buddy_read_invitations_invitee_id_status_idx" ON "buddy_read_invitations"("invitee_id", "status");

-- AddForeignKey
ALTER TABLE "buddy_read_invitations" ADD CONSTRAINT "buddy_read_invitations_buddy_read_id_fkey" FOREIGN KEY ("buddy_read_id") REFERENCES "buddy_reads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buddy_read_invitations" ADD CONSTRAINT "buddy_read_invitations_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buddy_read_invitations" ADD CONSTRAINT "buddy_read_invitations_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;