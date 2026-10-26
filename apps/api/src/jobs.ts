import type { AppContext } from "./context";
import { runDueJobs, type JobHandler } from "./lib/jobs";
import { processMediaAsset } from "./services/media";
import { enqueueAllPlaylists, rebuildPlaylist } from "./services/playlists";

export function jobHandlers(ctx: AppContext): Record<string, JobHandler> {
  return {
    "playlist.build": async (p) => {
      await rebuildPlaylist(ctx, String(p.vehicleId));
    },
    "playlist.build_all": async () => {
      await enqueueAllPlaylists(ctx.sql);
    },
    "media.process": async (p) => {
      await processMediaAsset(ctx, String(p.mediaAssetId));
    },
  };
}

/** Arbeitet alle fälligen Jobs ab (für Tests und Skripte). */
export async function drainJobs(ctx: AppContext, maxRounds = 50): Promise<void> {
  const handlers = jobHandlers(ctx);
  for (let i = 0; i < maxRounds; i++) {
    if ((await runDueJobs(ctx.sql, handlers, 50)) === 0) return;
  }
}
