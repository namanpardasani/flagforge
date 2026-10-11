import type { StreamStatus } from "@/api/stream";
import { createStore } from "./create-store";

/**
 * Whether the live stream is working right now. While it is not, the flag list falls back to
 * refetching on a timer, so the screen cannot sit stale for long.
 */
const store = createStore<StreamStatus | "off">("off");
export const setLiveStatus = (status: StreamStatus | "off") => store.set(status);
export const useLiveStatus = () => store.use((state) => state);
export const resetLiveStatus = () => store.set("off");
