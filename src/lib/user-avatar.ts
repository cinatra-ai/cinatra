// The app's user avatar helper (cinatra#4292): the accent ground and the
// initials of a person's avatar fallback. It re-exports the shared helper so
// that app code can import it. The app's own avatars do not use it yet; the
// users today are packages/sdk-ui/src/permissions-panel.tsx,
// packages/sdk-ui/src/prompt-field.tsx and
// packages/chat/src/chat-messages-view.tsx.
export {
  userAvatarAccent,
  userInitials,
  type UserAvatarSource,
} from "@cinatra-ai/sdk-ui/lib/user-avatar";
