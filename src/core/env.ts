/** Cairn - shared process-environment type (read at call time; injectable for tests). */
export type Env = Record<string, string | undefined>;
