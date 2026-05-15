export type SidebarConversationRecord = Record<string, unknown>;

function isFavorite(conv: SidebarConversationRecord): boolean {
  return conv.favorite === true || Number(conv.favoritedAt) > 0;
}

function numericTimestamp(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function sortConversationsWithinPeer(
  conversations: SidebarConversationRecord[],
): SidebarConversationRecord[] {
  return conversations
    .map((conv, index) => ({ conv, index }))
    .sort((left, right) => {
      const leftFavorite = isFavorite(left.conv);
      const rightFavorite = isFavorite(right.conv);
      if (leftFavorite !== rightFavorite) {
        return leftFavorite ? -1 : 1;
      }

      if (leftFavorite && rightFavorite) {
        const leftFavoritedAt = numericTimestamp(left.conv.favoritedAt);
        const rightFavoritedAt = numericTimestamp(right.conv.favoritedAt);
        if (leftFavoritedAt !== rightFavoritedAt) {
          return rightFavoritedAt - leftFavoritedAt;
        }
      }

      return left.index - right.index;
    })
    .map(({ conv }) => conv);
}
