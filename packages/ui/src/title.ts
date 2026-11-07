// What the browser's tab, its history, bookmarks and share sheet call each app: the club's own name, as the
// installed app is named (manifest.ts), never a product's. The staff app's, like its installed name, adds " Staff".
export type AppKind = "member" | "staff";
export const pageTitle = (clubName: string, app: AppKind): string => {
  const name = clubName.trim();
  return app === "staff" ? `${name} Staff` : name;
};
