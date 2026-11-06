// What a pay sheet is for, from what it was opened with. Two separate ideas:
//  - saving a card (a membership joined before its plan starts, the family card): nothing is charged, so the card
//    form is a card setup (Stripe's confirmSetup), opened without the bot check;
//  - paying: a payment, so the card form passes the bot check first (the server's bot.ts) and is confirmed as a
//    payment (confirmPayment), then checked with Kumi until it's recorded.
// Card only (a gift card or a pass) is a payment, by card alone: club credit, passes and promo codes can't pay for
// one (the server refuses), so the sheet doesn't offer them. It is not a saved card.
export type PayMode = { saveCard: boolean; extras: boolean };
export function payMode(o: { cardFor?: string; familyCard?: boolean; cardOnly?: boolean }): PayMode {
  const saveCard = Boolean(o.cardFor || o.familyCard);
  return { saveCard, extras: !saveCard && !o.cardOnly };
}
