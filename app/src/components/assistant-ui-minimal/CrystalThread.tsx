// Minimal assistant-ui adoption spike (docs/xperiq-assistant-ui/BRIEF.md).
//
// Deliberately thin: composes assistant-ui's own primitives
// (`ThreadPrimitive`, `MessagePrimitive`, `ComposerPrimitive`) with just enough
// Tailwind + Xperiq CSS-variable theming to be legible — not a pixel-matched
// rebuild of `CrystalPanel.tsx`'s bespoke chat UI. Colors are wired through
// `var(--color-*)` (Xperiq's brand token system — see `app/CLAUDE.md` "Brand
// Theme System"), never assistant-ui's own default palette or a literal hex.
//
// Registry note: the officially "default-styled" Thread/Composer components
// are distributed via a shadcn-style CLI (`npx shadcn add @assistant-ui/thread`)
// that fetches source from `r.assistant-ui.com` at install time — that host
// was unreachable from this sandbox's network policy, so this component was
// hand-composed directly from the underlying (npm-published, reachable)
// `@assistant-ui/react` primitives instead of the CLI-scaffolded defaults.
// See docs/xperiq-assistant-ui/RESULT.md for the full account.
import { ComposerPrimitive, MessagePrimitive, ThreadPrimitive, type TextMessagePartProps } from '@assistant-ui/react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from '../../lib/i18n';

// One thing assistant-ui gives for free that Crystal's hand-built panel never
// had (CURRENT_STATE.md: "No markdown rendering — CrystalBubble renders
// content through CitedText, which emits plain <span>s"): assistant answers
// often contain `**bold**`/lists/tables, which rendered as literal asterisks
// before. `MarkdownTextPrimitive` reads the current part's text from context
// (`useMessagePartText()`), so it's a drop-in `Text` slot — no custom
// markdown parsing to hand-roll.
function CrystalAssistantText(_props: TextMessagePartProps) {
  return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className="crystal-assistant-ui-markdown text-sm" />;
}

function CrystalUserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div
        className="max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap break-words"
        style={{ background: 'var(--color-primary)', color: 'var(--color-primary-foreground)' }}
      >
        <MessagePrimitive.Content />
      </div>
    </MessagePrimitive.Root>
  );
}

function CrystalAssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-start">
      <div
        className="max-w-[80%] rounded-2xl px-4 py-2 text-sm break-words"
        style={{ background: 'var(--color-surface-container)', color: 'var(--color-on-surface)' }}
      >
        <MessagePrimitive.Content components={{ Text: CrystalAssistantText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function CrystalEmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-sm font-semibold" style={{ color: 'var(--color-on-surface)' }}>
        {t('crystalAssistantUi.emptyThreadTitle')}
      </p>
      <p className="text-xs" style={{ color: 'var(--color-on-surface-variant)' }}>
        {t('crystalAssistantUi.emptyThreadSubtitle')}
      </p>
    </div>
  );
}

export function CrystalThread() {
  const { t } = useTranslation();

  return (
    <ThreadPrimitive.Root className="flex h-full flex-col">
      <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {/* ThreadPrimitive.Empty is deprecated in favor of `<AuiIf condition={(s) =>
            s.thread.isEmpty} />`, which isn't re-exported from the `@assistant-ui/react`
            wrapper package (only from `@assistant-ui/core`, an undeclared transitive
            dep) — using the still-functional, still-exported primitive here rather
            than reaching into a package we don't depend on directly. One more
            concrete instance of the "unstable_/deprecated API churn" risk flagged
            in docs/xperiq-assistant-ui/RESULT.md. */}
        <ThreadPrimitive.Empty>
          <CrystalEmptyState />
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages>
          {({ message }) => (message.role === 'user' ? <CrystalUserMessage /> : <CrystalAssistantMessage />)}
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>
      <ComposerPrimitive.Root
        className="flex items-end gap-2 border-t p-3"
        style={{ borderColor: 'var(--color-outline-variant)' }}
      >
        <ComposerPrimitive.Input
          placeholder={t('crystalAssistantUi.composerPlaceholder')}
          rows={1}
          className="flex-1 resize-none rounded-xl border px-3 py-2 text-sm outline-none"
          style={{
            borderColor: 'var(--color-outline-variant)',
            background: 'var(--color-surface-container-lowest)',
            color: 'var(--color-on-surface)',
          }}
        />
        <ComposerPrimitive.Send
          className="rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-40"
          style={{ background: 'var(--color-primary)', color: 'var(--color-primary-foreground)' }}
        >
          {t('crystalAssistantUi.send')}
        </ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
