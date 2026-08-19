// Minimal assistant-ui adoption spike (docs/xperiq-assistant-ui/BRIEF.md).
//
// Sidebar built on assistant-ui's `ThreadListPrimitive`/`ThreadListItemPrimitive`
// primitives, backed by the localStorage `useCrystalThreadStore` (via the
// `ExternalStoreThreadListAdapter` wired in `useCrystalAssistantUiRuntime`).
//
// Rename has no dedicated assistant-ui primitive (only Trigger/Archive/
// Unarchive/Delete/Title exist — see `@assistant-ui/react`'s
// `threadListItem.d.ts`), so it calls `store.renameThread(...)` directly
// rather than through the runtime — both paths update the same underlying
// store, so this is equivalent, not a workaround.
import { useState, type CSSProperties } from 'react';
import { ThreadListItemPrimitive, ThreadListPrimitive, type ThreadListItemState } from '@assistant-ui/react';
import { Icon } from '../Icon';
import { useTranslation } from '../../lib/i18n';
import type { CrystalThreadStore } from '../../hooks/useCrystalThreadStore';

interface CrystalThreadRowProps {
  // `status` also allows `"new"` (a transient runtime state, not one of our
  // two persisted statuses) — branch on `=== 'archived'` rather than
  // `=== 'regular'` below so `"new"` renders like a regular thread.
  item: Pick<ThreadListItemState, 'id' | 'title' | 'status'>;
  store: CrystalThreadStore;
}

function iconButtonStyle(): CSSProperties {
  return { color: 'var(--color-on-surface-variant)' };
}

function CrystalThreadRow({ item, store }: CrystalThreadRowProps) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(item.title ?? '');
  const isActive = item.id === store.currentThreadId;

  const commitRename = () => {
    setIsEditing(false);
    if (draft.trim()) store.renameThread(item.id, draft);
    else setDraft(item.title ?? '');
  };

  return (
    <ThreadListItemPrimitive.Root
      className="group flex items-center gap-1 rounded-lg px-2 py-1.5"
      style={{ background: isActive ? 'var(--color-primary-container)' : 'transparent' }}
    >
      {isEditing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
            if (e.key === 'Escape') { setDraft(item.title ?? ''); setIsEditing(false); }
          }}
          className="min-w-0 flex-1 rounded border px-1.5 py-0.5 text-sm outline-none"
          style={{ borderColor: 'var(--color-outline-variant)', color: 'var(--color-on-surface)' }}
          aria-label={t('crystalAssistantUi.renamePrompt')}
        />
      ) : (
        <ThreadListItemPrimitive.Trigger
          className="min-w-0 flex-1 truncate text-left text-sm"
          style={{ color: 'var(--color-on-surface)' }}
        >
          <ThreadListItemPrimitive.Title fallback={t('crystalAssistantUi.untitledThread')} />
        </ThreadListItemPrimitive.Trigger>
      )}

      <button
        type="button"
        onClick={() => { setDraft(item.title ?? ''); setIsEditing(true); }}
        aria-label={t('crystalAssistantUi.renameThread')}
        className="opacity-0 group-hover:opacity-100 focus:opacity-100"
        style={iconButtonStyle()}
      >
        <Icon name="edit" size={16} />
      </button>

      {item.status === 'archived' ? (
        <ThreadListItemPrimitive.Unarchive
          aria-label={t('crystalAssistantUi.unarchiveThread')}
          className="opacity-0 group-hover:opacity-100 focus:opacity-100"
          style={iconButtonStyle()}
        >
          <Icon name="unarchive" size={16} />
        </ThreadListItemPrimitive.Unarchive>
      ) : (
        <ThreadListItemPrimitive.Archive
          aria-label={t('crystalAssistantUi.archiveThread')}
          className="opacity-0 group-hover:opacity-100 focus:opacity-100"
          style={iconButtonStyle()}
        >
          <Icon name="archive" size={16} />
        </ThreadListItemPrimitive.Archive>
      )}

      <ThreadListItemPrimitive.Delete
        aria-label={t('crystalAssistantUi.deleteThread')}
        className="opacity-0 group-hover:opacity-100 focus:opacity-100"
        style={iconButtonStyle()}
      >
        <Icon name="delete" size={16} />
      </ThreadListItemPrimitive.Delete>
    </ThreadListItemPrimitive.Root>
  );
}

interface CrystalThreadListProps {
  store: CrystalThreadStore;
}

export function CrystalThreadList({ store }: CrystalThreadListProps) {
  const { t } = useTranslation();
  const hasArchived = store.threads.some((th) => th.status === 'archived');

  return (
    <ThreadListPrimitive.Root className="flex h-full flex-col gap-2 p-3">
      <ThreadListPrimitive.New
        className="flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold"
        style={{ background: 'var(--color-primary)', color: 'var(--color-primary-foreground)' }}
      >
        <Icon name="add" size={16} />
        {t('crystalAssistantUi.newThread')}
      </ThreadListPrimitive.New>

      <p
        className="mt-2 px-1 text-xs font-semibold uppercase tracking-wide"
        style={{ color: 'var(--color-on-surface-variant)' }}
      >
        {t('crystalAssistantUi.threadListTitle')}
      </p>
      <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
        <ThreadListPrimitive.Items>
          {({ threadListItem }) => <CrystalThreadRow item={threadListItem} store={store} />}
        </ThreadListPrimitive.Items>
      </div>

      {hasArchived && (
        <>
          <p
            className="mt-2 px-1 text-xs font-semibold uppercase tracking-wide"
            style={{ color: 'var(--color-on-surface-variant)' }}
          >
            {t('crystalAssistantUi.archivedSectionTitle')}
          </p>
          <div className="flex flex-col gap-1 overflow-y-auto">
            <ThreadListPrimitive.Items archived>
              {({ threadListItem }) => <CrystalThreadRow item={threadListItem} store={store} />}
            </ThreadListPrimitive.Items>
          </div>
        </>
      )}
    </ThreadListPrimitive.Root>
  );
}
