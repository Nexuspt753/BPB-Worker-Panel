// Settings auto-backup and rollback.
//
// Snapshots the current proxySettings into KV before every settings apply so
// the owner can one-click restore a previous working state. Keeps the newest N
// snapshots; older ones are trimmed. Never exports secrets: the snapshot is
// the raw `proxySettings` value (which does not contain apiToken/accID — those
// live in EMBEDED_SETTINGS, not KV).
//
// Self-contained: takes `env`, no `@settings` import.

import { safeError } from '@common';

const BACKUP_PREFIX = 'backup:';
const BACKUP_MAX = 20;

export interface BackupMeta {
    ts: number;
    preview: string;
}

export interface BackupEntry {
    ts: number;
    preview: string;
    value: string;
}

/**
 * Snapshot the current proxySettings (best-effort). Returns false when the
 * snapshot could not be written; the caller proceeds with the apply regardless.
 */
export async function snapshotSettings(env: Env): Promise<boolean> {
    try {
        const current = await env.kv.get('proxySettings');
        if (typeof current !== 'string' || !current) return false;
        const ts = Date.now();
        const parsed = (() => {
            try { return JSON.parse(current); } catch { return null; }
        })();
        const preview = typeof parsed === 'string' ? parsed.slice(0, 200) : current.slice(0, 200);
        await env.kv.put(`${BACKUP_PREFIX}${ts}`, JSON.stringify({ ts, preview, value: current }));
        await trimBackups(env, ts);
        return true;
    } catch (error) {
        console.error('[backup]', safeError(error));
        return false;
    }
}

export async function listBackups(env: Env): Promise<BackupMeta[]> {
    try {
        const listed = await env.kv.list({ prefix: BACKUP_PREFIX });
        const out: BackupMeta[] = [];
        for (const key of listed.keys) {
            const raw = await env.kv.get(key.name, { type: 'json' }) as BackupEntry | null;
            if (!raw || typeof raw.ts !== 'number') continue;
            out.push({ ts: raw.ts, preview: typeof raw.preview === 'string' ? raw.preview : '' });
        }
        return out.sort((a, b) => b.ts - a.ts).slice(0, BACKUP_MAX);
    } catch {
        return [];
    }
}

export async function getBackup(env: Env, ts: number): Promise<string | null> {
    try {
        const raw = await env.kv.get(`${BACKUP_PREFIX}${ts}`, { type: 'json' }) as BackupEntry | null;
        if (!raw || typeof raw.value !== 'string') return null;
        return raw.value;
    } catch {
        return null;
    }
}

export async function deleteBackup(env: Env, ts: number): Promise<void> {
    await env.kv.delete(`${BACKUP_PREFIX}${ts}`);
}

async function trimBackups(env: Env, newestTs: number): Promise<void> {
    try {
        const listed = await env.kv.list({ prefix: BACKUP_PREFIX });
        const times = listed.keys
            .map(key => Number(key.name.slice(BACKUP_PREFIX.length)))
            .filter(ts => Number.isFinite(ts))
            .sort((a, b) => b - a);
        const toDelete = times.slice(BACKUP_MAX);
        for (const ts of toDelete) {
            if (ts === newestTs) continue;
            await deleteBackup(env, ts);
        }
    } catch (error) {
        console.error('[backup]', safeError(error));
    }
}
