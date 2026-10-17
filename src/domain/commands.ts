import type { CommandType } from "./types.ts";
import type { Handler } from "./store.ts";
import { captureHandlers } from "./handlers/capture.ts";
import { quietHandlers } from "./handlers/quiet.ts";
import { planHandlers } from "./handlers/plan.ts";
import { draftHandlers } from "./handlers/draft.ts";
import { governanceHandlers } from "./handlers/governance.ts";
import { contextReviewHandlers } from "./handlers/contextReview.ts";
import { sourceRevocationHandlers } from "./handlers/sourceRevocation.ts";
import { intentHandlers } from "./handlers/intent.ts";
import { checkpointNoteHandlers } from "./handlers/checkpointNote.ts";
import { protectedBlockHandlers } from "./handlers/protectedBlock.ts";
import { attentionDueHandlers } from "./handlers/attentionDue.ts";
import { agreementHandlers } from "./handlers/agreement.ts";

export const commandHandlers = {
  ...captureHandlers,
  ...quietHandlers,
  ...planHandlers,
  ...draftHandlers,
  ...governanceHandlers,
  ...contextReviewHandlers,
  ...sourceRevocationHandlers,
  ...intentHandlers,
  ...checkpointNoteHandlers,
  ...protectedBlockHandlers,
  ...attentionDueHandlers,
  ...agreementHandlers,
} as Record<CommandType, Handler>;
