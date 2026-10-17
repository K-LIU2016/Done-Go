import { S11Context } from "../screens/s11-context/S11Context";
import { S12Review } from "../screens/s12-review/S12Review";
import { S13Sync } from "../screens/s13-sync/S13Sync";
import { S14Capture } from "../screens/s14-capture/S14Capture";
import { S15MNow } from "../screens/s15-m-now/S15MNow";
import { S16MPlan } from "../screens/s16-m-plan/S16MPlan";
import { S17MAuth } from "../screens/s17-m-auth/S17MAuth";
import { S18MStillness } from "../screens/s18-m-stillness/S18MStillness";
import { MobileStage } from "../shell/Shell";
import type { RouteGroup } from "./types";

export const groupC: RouteGroup = {
  shell: [
    { path: "/context", element: <S11Context /> },
    { path: "/review", element: <S12Review /> },
    { path: "/sync", element: <S13Sync /> },
    { path: "/capture", element: <S14Capture /> },
  ],
  bare: [
    {
      path: "/m/now",
      element: (
        <MobileStage>
          <S15MNow />
        </MobileStage>
      ),
    },
    {
      path: "/m/plan",
      element: (
        <MobileStage>
          <S16MPlan />
        </MobileStage>
      ),
    },
    {
      path: "/m/auth",
      element: (
        <MobileStage>
          <S17MAuth />
        </MobileStage>
      ),
    },
    {
      path: "/m/stillness",
      element: (
        <MobileStage>
          <S18MStillness />
        </MobileStage>
      ),
    },
  ],
};
