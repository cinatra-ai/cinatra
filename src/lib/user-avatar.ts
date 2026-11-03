// The app's user avatar helper (cinatra#4292): the accent ground and the
// initials of a person's avatar fallback. It re-exports the shared helper so
// the app and the packages draw a person's avatar from one implementation.
export {
  userAvatarAccent,
  userInitials,
  type UserAvatarSource,
} from "@cinatra-ai/sdk-ui/lib/user-avatar";
