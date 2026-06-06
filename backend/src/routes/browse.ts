import { Router } from "express";
import { withRetry } from "../utils/async";
import { logger } from "../utils/logger";
import { requireAuthOrToken } from "../middleware/auth";
import { safeError } from "../utils/errors";
import { spotifyService } from "../services/spotify";
import { deezerService, DeezerPlaylistPreview, DeezerRadioStation } from "../services/deezer";

const router = Router();

// All routes require authentication
router.use(requireAuthOrToken);

/**
 * Unified playlist preview type
 */
interface PlaylistPreview {
    id: string;
    source: "deezer" | "spotify";
    type: "playlist" | "radio";
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    url: string;
}

/**
 * Convert Deezer playlist to unified format
 */
function deezerPlaylistToUnified(playlist: DeezerPlaylistPreview): PlaylistPreview {
    return {
        id: playlist.id,
        source: "deezer",
        type: "playlist",
        title: playlist.title,
        description: playlist.description,
        creator: playlist.creator,
        imageUrl: playlist.imageUrl,
        trackCount: playlist.trackCount,
        url: `https://www.deezer.com/playlist/${playlist.id}`,
    };
}

/**
 * Convert Deezer radio to unified format
 */
function deezerRadioToUnified(radio: DeezerRadioStation): PlaylistPreview {
    return {
        id: radio.id,
        source: "deezer",
        type: "radio",
        title: radio.title,
        description: radio.description,
        creator: "Deezer",
        imageUrl: radio.imageUrl,
        trackCount: 0, // Radio tracks are dynamic
        url: `https://www.deezer.com/radio-${radio.id}`,
    };
}

/**
 * GET /api/browse/playlists/featured
 * Get featured/chart playlists from Deezer
 */
router.get("/playlists/featured", async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        logger.debug(`[Browse] Fetching featured playlists (limit: ${limit})...`);

        const playlists = await deezerService.getFeaturedPlaylists(limit);
        logger.debug(`[Browse] Got ${playlists.length} Deezer playlists`);

        res.json({
            playlists: playlists.map(deezerPlaylistToUnified),
            total: playlists.length,
            source: "deezer",
        });
    } catch (error) {
        safeError(res, "Browse featured playlists", error);
    }
});

/**
 * GET /api/browse/playlists/search
 * Search for playlists on Deezer
 */
router.get("/playlists/search", async (req, res) => {
    try {
        const query = req.query.q as string;
        if (!query || query.length < 2) {
            return res.status(400).json({ error: "Search query must be at least 2 characters" });
        }

        const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
        logger.debug(`[Browse] Searching playlists for "${query}"...`);

        const playlists = await deezerService.searchPlaylists(query, limit);
        logger.debug(`[Browse] Search "${query}": ${playlists.length} results`);

        res.json({
            playlists: playlists.map(deezerPlaylistToUnified),
            total: playlists.length,
            query,
            source: "deezer",
        });
    } catch (error) {
        safeError(res, "Browse search playlists", error);
    }
});

/**
 * GET /api/browse/playlists/:id
 * Get full details of a Deezer playlist
 */
router.get("/playlists/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const playlist = await withRetry(() => deezerService.getPlaylist(id));

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        res.json({
            ...playlist,
            source: "deezer",
            url: `https://www.deezer.com/playlist/${id}`,
        });
    } catch (error) {
        safeError(res, "Playlist fetch", error);
    }
});

/**
 * GET /api/browse/radios
 * Get all radio stations (mood/theme based mixes)
 */
router.get("/radios", async (_req, res) => {
    try {
        logger.debug("[Browse] Fetching radio stations...");
        const radios = await deezerService.getRadioStations();

        res.json({
            radios: radios.map(deezerRadioToUnified),
            total: radios.length,
            source: "deezer",
        });
    } catch (error) {
        safeError(res, "Browse radios", error);
    }
});

/**
 * GET /api/browse/radios/by-genre
 * Get radio stations organized by genre
 */
router.get("/radios/by-genre", async (_req, res) => {
    try {
        logger.debug("[Browse] Fetching radios by genre...");
        const genresWithRadios = await deezerService.getRadiosByGenre();

        // Transform to include unified format
        const result = genresWithRadios.map(genre => ({
            id: genre.id,
            name: genre.name,
            radios: genre.radios.map(deezerRadioToUnified),
        }));

        res.json({
            genres: result,
            total: result.length,
            source: "deezer",
        });
    } catch (error) {
        safeError(res, "Browse radios by genre", error);
    }
});

/**
 * GET /api/browse/radios/:id
 * Get tracks from a radio station (as playlist format for import)
 */
router.get("/radios/:id", async (req, res) => {
    try {
        const { id } = req.params;
        logger.debug(`[Browse] Fetching radio ${id} tracks...`);
        
        const radioPlaylist = await deezerService.getRadioTracks(id);

        if (!radioPlaylist) {
            return res.status(404).json({ error: "Radio station not found" });
        }

        res.json({
            ...radioPlaylist,
            source: "deezer",
            type: "radio",
        });
    } catch (error) {
        safeError(res, "Radio tracks", error);
    }
});

/**
 * GET /api/browse/genres
 * Get all available genres
 */
router.get("/genres", async (_req, res) => {
    try {
        logger.debug("[Browse] Fetching genres...");
        const genres = await deezerService.getGenres();

        res.json({
            genres,
            total: genres.length,
            source: "deezer",
        });
    } catch (error) {
        safeError(res, "Browse genres", error);
    }
});

/**
 * GET /api/browse/genres/:id
 * Get content for a specific genre (playlists + radios)
 */
router.get("/genres/:id", async (req, res) => {
    try {
        const genreId = parseInt(req.params.id);
        if (isNaN(genreId)) {
            return res.status(400).json({ error: "Invalid genre ID" });
        }

        logger.debug(`[Browse] Fetching content for genre ${genreId}...`);
        const content = await deezerService.getEditorialContent(genreId);

        res.json({
            genreId,
            playlists: content.playlists.map(deezerPlaylistToUnified),
            radios: content.radios.map(deezerRadioToUnified),
            source: "deezer",
        });
    } catch (error) {
        safeError(res, "Genre content", error);
    }
});

/**
 * GET /api/browse/genres/:id/playlists
 * Get playlists for a specific genre (by name search)
 */
router.get("/genres/:id/playlists", async (req, res) => {
    try {
        const genreId = parseInt(req.params.id);
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

        // Get genre name first
        const genres = await deezerService.getGenres();
        const genre = genres.find(g => g.id === genreId);

        if (!genre) {
            return res.status(404).json({ error: "Genre not found" });
        }

        const playlists = await deezerService.getGenrePlaylists(genre.name, limit);

        res.json({
            playlists: playlists.map(deezerPlaylistToUnified),
            total: playlists.length,
            genre: genre.name,
            source: "deezer",
        });
    } catch (error) {
        safeError(res, "Genre playlists", error);
    }
});

/**
 * POST /api/browse/playlists/parse
 * Parse a Spotify or Deezer URL and return playlist info
 * This is the main entry point for URL-based imports
 */
router.post("/playlists/parse", async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ error: "URL is required" });
        }

        // Try Deezer first (our primary source)
        const deezerParsed = deezerService.parseUrl(url);
        if (deezerParsed && deezerParsed.type === "playlist") {
            return res.json({
                source: "deezer",
                type: "playlist",
                id: deezerParsed.id,
                url: `https://www.deezer.com/playlist/${deezerParsed.id}`,
            });
        }

        // Try Spotify (still supported for URL imports)
        const spotifyParsed = spotifyService.parseUrl(url);
        if (spotifyParsed && spotifyParsed.type === "playlist") {
            return res.json({
                source: "spotify",
                type: "playlist",
                id: spotifyParsed.id,
                url: `https://open.spotify.com/playlist/${spotifyParsed.id}`,
            });
        }

        // Try YouTube / YouTube Music -- extract list= query param as playlist ID
        try {
            const parsed = new URL(url);
            const hostname = parsed.hostname.toLowerCase();
            const isYouTube =
                hostname.includes("youtube.com") ||
                hostname.includes("youtu.be") ||
                hostname.includes("music.youtube.com");
            if (isYouTube) {
                const listId = parsed.searchParams.get("list");
                if (listId) {
                    return res.json({
                        source: "youtube",
                        type: "playlist",
                        id: listId,
                        url,
                    });
                }
            }
        } catch {
            // Invalid URL -- fall through to error
        }

        return res.status(400).json({
            error: "Invalid or unsupported URL. Please provide a Spotify, Deezer, or YouTube playlist URL."
        });
    } catch (error) {
        safeError(res, "Parse URL", error);
    }
});

/**
 * GET /api/browse/all
 * Get a combined view of featured content (playlists, genres)
 * Note: Radio stations are now internal (library-based), not from Deezer
 */
router.get("/all", async (_req, res) => {
    try {
        logger.debug("[Browse] Fetching browse content (playlists + genres)...");

        // Fetch just the chart's 99 here — a single fast Deezer call — so the
        // browse page paints immediately. The page then lazily pulls the
        // genre-sourced remainder from /playlists/featured?limit=200.
        const [playlists, genres] = await Promise.all([
            deezerService.getFeaturedPlaylists(99),
            deezerService.getGenres(),
        ]);

        res.json({
            playlists: playlists.map(deezerPlaylistToUnified),
            radios: [],
            genres,
            source: "deezer",
        });
    } catch (error) {
        safeError(res, "Browse all", error);
    }
});

export default router;
