import type { RouteGroup } from "./types";
import { WorkspaceScreen } from "../screens/s06-workspace/WorkspaceScreen";
import { SessionScreen } from "../screens/s07-session/SessionScreen";
import { StillnessScreen } from "../screens/s08-stillness/StillnessScreen";
import { AttentionScreen } from "../screens/s09-attention/AttentionScreen";
import { BoundariesScreen } from "../screens/s10-boundaries/BoundariesScreen";

export const groupB: RouteGroup = {
  shell: [
    { path: "/workspace", element: <WorkspaceScreen /> },
    { path: "/session", element: <SessionScreen /> },
    { path: "/attention", element: <AttentionScreen /> },
    { path: "/boundaries", element: <BoundariesScreen /> },
  ],
  bare: [{ path: "/stillness", element: <StillnessScreen /> }],
};
