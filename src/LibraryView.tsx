import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import {
  renameSongLibraryItem,
  subscribeSongLibrary,
  type SongLibraryItem,
} from "./lib/songLibrary";

export type LibraryViewProps = {
  ownerUid: string | null;
  activeJobId?: string | null;
  className?: string;
  onImport: () => void;
  onSelect: (song: SongLibraryItem) => void | Promise<void>;
};

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function statusLabel(song: SongLibraryItem): string {
  if (song.status === "completed") return "Ready";
  if (song.status === "failed") return "Needs attention";
  if (song.stage === "queued_for_download") return "Waiting to download";
  if (song.status === "awaiting_upload") return "Uploading";
  return "Processing";
}

function sourceLabel(song: SongLibraryItem): string {
  if (song.sourceProvider === "youtube") return "YouTube";
  if (song.sourceProvider === "spotify") return "Spotify";
  return "Uploaded file";
}

function formatDate(milliseconds: number | null): string {
  if (milliseconds === null) return "Just now";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: new Date(milliseconds).getFullYear() === new Date().getFullYear()
      ? undefined
      : "numeric",
  }).format(milliseconds);
}

function formatBpm(bpm: number | null): string {
  return bpm === null ? "— BPM" : `${Math.round(bpm)} BPM`;
}

export default function LibraryView({
  ownerUid,
  activeJobId = null,
  className,
  onImport,
  onSelect,
}: LibraryViewProps) {
  const [songs, setSongs] = useState<SongLibraryItem[]>([]);
  const [loading, setLoading] = useState(Boolean(ownerUid));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setLoadError(null);
    setActionError(null);
    setEditingId(null);
    if (!ownerUid) {
      setSongs([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const subscription = subscribeSongLibrary(
      ownerUid,
      (items) => {
        setSongs(items);
        setLoading(false);
        setLoadError(null);
      },
      (error) => {
        setLoading(false);
        setLoadError(error.message || "Your saved songs could not be loaded.");
      },
    );
    return subscription.unsubscribe;
  }, [ownerUid]);

  const readyCount = useMemo(
    () => songs.filter((song) => song.canOpen).length,
    [songs],
  );

  const beginRename = useCallback((song: SongLibraryItem) => {
    setEditingId(song.id);
    setDraftTitle(song.title);
    setActionError(null);
  }, []);

  const cancelRename = useCallback(() => {
    setEditingId(null);
    setDraftTitle("");
    setActionError(null);
  }, []);

  const saveRename = useCallback(async (
    event: FormEvent<HTMLFormElement>,
    song: SongLibraryItem,
  ) => {
    event.preventDefault();
    setSavingId(song.id);
    setActionError(null);
    try {
      await renameSongLibraryItem(song.id, draftTitle);
      setEditingId(null);
      setDraftTitle("");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The title could not be changed.");
    } finally {
      setSavingId(null);
    }
  }, [draftTitle]);

  return (
    <section className={classNames("song-library", className)} aria-labelledby="song-library-title">
      <header className="song-library__header">
        <div>
          <span className="eyebrow">YOUR LIBRARY</span>
          <h1 id="song-library-title">Songs</h1>
          {ownerUid && !loading && (
            <p>{songs.length} saved · {readyCount} ready</p>
          )}
        </div>
        <button type="button" className="song-library__import" onClick={onImport}>
          Import song
        </button>
      </header>

      {!ownerUid && (
        <div className="song-library__empty">
          <strong>Sign in to open your library</strong>
          <p>Your uploads and completed Music.ai projects will appear here.</p>
        </div>
      )}

      {ownerUid && loading && (
        <div className="song-library__loading" role="status">
          Loading your songs…
        </div>
      )}

      {ownerUid && loadError && (
        <div className="song-library__error" role="alert">
          <strong>Library unavailable</strong>
          <p>{loadError}</p>
        </div>
      )}

      {ownerUid && !loading && !loadError && songs.length === 0 && (
        <div className="song-library__empty">
          <strong>Your first song starts here</strong>
          <p>Import an audio file or a supported link. Once the upload finishes, processing continues in the cloud.</p>
          <button type="button" onClick={onImport}>Import your first song</button>
        </div>
      )}

      {ownerUid && songs.length > 0 && (
        <div className="song-library__list" role="list">
          {songs.map((song) => {
            const editing = editingId === song.id;
            const saving = savingId === song.id;
            return (
              <article
                key={song.id}
                className={classNames(
                  "song-library__song",
                  song.id === activeJobId && "is-active",
                  song.status === "failed" && "has-error",
                )}
                data-status={song.status}
                role="listitem"
              >
                <div className="song-library__art" aria-hidden="true">
                  <span>♫</span>
                </div>

                <div className="song-library__details">
                  {editing ? (
                    <form
                      className="song-library__rename"
                      onSubmit={(event) => void saveRename(event, song)}
                    >
                      <label htmlFor={`song-title-${song.id}`}>Song title</label>
                      <input
                        id={`song-title-${song.id}`}
                        value={draftTitle}
                        maxLength={120}
                        autoFocus
                        disabled={saving}
                        onChange={(event) => setDraftTitle(event.target.value)}
                      />
                      <span className="song-library__rename-actions">
                        <button type="submit" disabled={saving || !draftTitle.trim()}>
                          {saving ? "Saving…" : "Save"}
                        </button>
                        <button type="button" disabled={saving} onClick={cancelRename}>
                          Cancel
                        </button>
                      </span>
                      {actionError && <small role="alert">{actionError}</small>}
                    </form>
                  ) : (
                    <>
                      <div className="song-library__title-row">
                        <h2>{song.title}</h2>
                        <button
                          type="button"
                          className="song-library__rename-button"
                          aria-label={`Rename ${song.title}`}
                          onClick={() => beginRename(song)}
                        >
                          Rename
                        </button>
                      </div>
                      <div className="song-library__facts">
                        <span>{song.key || "Key —"}</span>
                        <span>{formatBpm(song.bpm)}</span>
                        <span>{sourceLabel(song)}</span>
                        <time dateTime={song.createdAt ? new Date(song.createdAt).toISOString() : undefined}>
                          {formatDate(song.createdAt)}
                        </time>
                      </div>
                      {song.errorMessage && (
                        <p className="song-library__job-error">{song.errorMessage}</p>
                      )}
                    </>
                  )}
                </div>

                {!editing && (
                  <div className="song-library__status">
                    <span className="song-library__status-label">{statusLabel(song)}</span>
                    <button
                      type="button"
                      disabled={!song.canOpen}
                      onClick={() => void onSelect(song)}
                      aria-label={song.canOpen ? `Open ${song.title}` : `${song.title} is not ready`}
                    >
                      {song.canOpen ? "Open" : "Working"}
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
