#!/usr/bin/env tsx
/**
 * Maintenance Script: Resolve temp-MBID artists
 *
 * Artists ingested before a MusicBrainz match exists are created with a
 * synthetic `temp-<ts>-<rand>` MBID. The nightly data-integrity job only
 * consolidates a temp artist when a real-MBID twin with the SAME normalized
 * name already exists. Temp artists with no such twin linger forever (the
 * library accrued ~330 of them), which clutters search and breaks dedupe.
 *
 * This script clears that backlog. For each temp artist, in order:
 *   1. NAME-TWIN MERGE  - a real-MBID artist with the same normalizedName
 *                         already exists -> merge the temp into it (same rule
 *                         the data-integrity job uses, applied on demand).
 *   2. MBID RESOLVE     - MusicBrainz has a confident match for the name:
 *                           a. a local artist already holds that MBID -> merge.
 *                           b. otherwise -> adopt the real MBID on the temp row.
 *   3. UNRESOLVABLE     - no confident MusicBrainz match -> mark
 *                         enrichmentStatus='unresolvable' so the artist route
 *                         stops re-querying MusicBrainz on every page view.
 *
 * Merges move Album rows (with their tracks) onto the surviving artist; the
 * temp row's OwnedAlbum / SimilarArtist rows are removed via FK cascade on
 * delete (OwnedAlbum conflicts are resolved first so the move never errors).
 *
 * MusicBrainz is queried directly with a 1.1s rate limit (per MB etiquette).
 *
 * Usage:
 *   npx tsx scripts/resolve-temp-artists.ts            # dry-run (no writes)
 *   npx tsx scripts/resolve-temp-artists.ts --apply    # perform changes
 *   npx tsx scripts/resolve-temp-artists.ts --limit 25 # process first 25 only
 *
 * The MBID match threshold is intentionally conservative (MB score >= 90 and
 * normalized-name equality) to avoid mislabelling an artist.
 */

import { PrismaClient } from "@prisma/client";
import { areArtistNamesSimilar } from "../src/utils/artistNormalization";

const prisma = new PrismaClient();

const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.indexOf("--limit");
const LIMIT =
    limitArg !== -1 && process.argv[limitArg + 1]
        ? parseInt(process.argv[limitArg + 1], 10)
        : Infinity;

const MB_BASE = "https://musicbrainz.org/ws/2";
const MB_UA =
    "kima-hub-temp-artist-resolver/1.0 ( https://github.com/gossip31/kima-hub )";
const MB_MIN_SCORE = 90; // MusicBrainz relevance score (0-100)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface MbArtist {
    id: string;
    name: string;
    score?: number;
}

/**
 * Look up an artist on MusicBrainz and return a confident match, or null.
 * Confident = top result with score >= MB_MIN_SCORE AND a name fuzzily equal to
 * the query (fuzzball ratio >= 95, the same comparator ingestion dedupe uses).
 * This tolerates punctuation/spacing variants ("B. B. King" vs "B.B. King")
 * while still rejecting high-scoring near-misses.
 */
async function resolveMbid(name: string): Promise<MbArtist | null> {
    const url = `${MB_BASE}/artist?query=${encodeURIComponent(
        name
    )}&limit=5&fmt=json`;
    const res = await fetch(url, { headers: { "User-Agent": MB_UA } });
    if (!res.ok) {
        console.warn(`    ! MusicBrainz HTTP ${res.status} for "${name}"`);
        return null;
    }
    const data = (await res.json()) as { artists?: MbArtist[] };
    for (const a of data.artists ?? []) {
        if ((a.score ?? 0) >= MB_MIN_SCORE && areArtistNamesSimilar(name, a.name, 95)) {
            return a;
        }
    }
    return null;
}

/**
 * Merge a temp artist into the surviving artist: move albums across, resolve
 * OwnedAlbum PK collisions, then delete the temp row (FK cascade clears its
 * remaining OwnedAlbum / SimilarArtist rows).
 */
async function mergeInto(tempId: string, survivorId: string): Promise<number> {
    return prisma.$transaction(async (tx) => {
        const moved = await tx.album.updateMany({
            where: { artistId: tempId },
            data: { artistId: survivorId },
        });
        // Move OwnedAlbum rows that don't collide with the survivor's PK
        // (artistId, rgMbid); the colliding ones are dropped by the cascade.
        await tx.$executeRaw`
            UPDATE "OwnedAlbum" o
            SET "artistId" = ${survivorId}
            WHERE o."artistId" = ${tempId}
              AND NOT EXISTS (
                SELECT 1 FROM "OwnedAlbum" s
                WHERE s."artistId" = ${survivorId} AND s."rgMbid" = o."rgMbid"
              )
        `;
        await tx.artist.delete({ where: { id: tempId } });
        return moved.count;
    });
}

async function main() {
    console.log("=== Resolve temp-MBID artists ===");
    console.log(APPLY ? "MODE: APPLY (writing changes)\n" : "MODE: DRY-RUN (no writes)\n");

    const tempArtists = await prisma.artist.findMany({
        where: { mbid: { startsWith: "temp-" } },
        select: {
            id: true,
            name: true,
            normalizedName: true,
            _count: { select: { albums: true } },
        },
        orderBy: { name: "asc" },
    });

    console.log(`Found ${tempArtists.length} temp artists.\n`);

    const stats = {
        nameTwinMerge: 0,
        mbidMerge: 0,
        mbidResolve: 0,
        unresolvable: 0,
        skippedLimit: 0,
        errors: 0,
        albumsMoved: 0,
    };
    let processed = 0;
    let needsMb = false; // whether the previous iteration hit MusicBrainz

    for (const temp of tempArtists) {
        if (processed >= LIMIT) {
            stats.skippedLimit++;
            continue;
        }
        processed++;

        try {
            // 1. Name-twin merge (free, no MusicBrainz call)
            const nameTwin = await prisma.artist.findFirst({
                where: {
                    normalizedName: temp.normalizedName,
                    mbid: { not: { startsWith: "temp-" } },
                },
                select: { id: true, name: true },
            });
            if (nameTwin) {
                console.log(
                    `[name-twin] "${temp.name}" (${temp._count.albums} albums) -> "${nameTwin.name}"`
                );
                if (APPLY) stats.albumsMoved += await mergeInto(temp.id, nameTwin.id);
                stats.nameTwinMerge++;
                continue;
            }

            // MusicBrainz lookup (rate-limited to ~1 req/s)
            if (needsMb) await sleep(1100);
            needsMb = true;
            const mb = await resolveMbid(temp.name);

            if (!mb) {
                console.log(`[unresolvable] "${temp.name}" - no confident MB match`);
                if (APPLY) {
                    await prisma.artist.update({
                        where: { id: temp.id },
                        data: { enrichmentStatus: "unresolvable" },
                    });
                }
                stats.unresolvable++;
                continue;
            }

            // 2a. A local artist already holds the resolved MBID -> merge
            const mbidTwin = await prisma.artist.findFirst({
                where: { mbid: mb.id, id: { not: temp.id } },
                select: { id: true, name: true },
            });
            if (mbidTwin) {
                console.log(
                    `[mbid-merge] "${temp.name}" -> "${mbidTwin.name}" (${mb.id})`
                );
                if (APPLY) stats.albumsMoved += await mergeInto(temp.id, mbidTwin.id);
                stats.mbidMerge++;
                continue;
            }

            // 2b. Adopt the real MBID on the temp row
            console.log(`[resolve] "${temp.name}" -> MBID ${mb.id}`);
            if (APPLY) {
                try {
                    await prisma.artist.update({
                        where: { id: temp.id },
                        data: { mbid: mb.id, enrichmentStatus: "pending" },
                    });
                } catch (e: any) {
                    // Lost a race for the MBID -> fall back to merge
                    if (e.code === "P2002") {
                        const winner = await prisma.artist.findFirst({
                            where: { mbid: mb.id, id: { not: temp.id } },
                            select: { id: true },
                        });
                        if (winner) {
                            stats.albumsMoved += await mergeInto(temp.id, winner.id);
                        }
                    } else {
                        throw e;
                    }
                }
            }
            stats.mbidResolve++;
        } catch (err) {
            stats.errors++;
            console.error(`    ! Error processing "${temp.name}":`, err);
        }
    }

    console.log("\n=== Summary ===");
    console.log(`  Name-twin merges:   ${stats.nameTwinMerge}`);
    console.log(`  MBID merges:        ${stats.mbidMerge}`);
    console.log(`  MBID resolved:      ${stats.mbidResolve}`);
    console.log(`  Unresolvable:       ${stats.unresolvable}`);
    console.log(`  Errors:             ${stats.errors}`);
    if (LIMIT !== Infinity) console.log(`  Skipped (--limit):  ${stats.skippedLimit}`);
    if (APPLY) console.log(`  Albums moved:       ${stats.albumsMoved}`);
    if (!APPLY) console.log("\nDry-run only. Re-run with --apply to perform changes.");
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
