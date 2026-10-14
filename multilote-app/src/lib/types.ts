export type Marketplace = "wallapop" | "vinted" | "milanuncios";

export const MARKETPLACES: { id: Marketplace; name: string }[] = [
  { id: "wallapop", name: "Wallapop" },
  { id: "vinted", name: "Vinted" },
  { id: "milanuncios", name: "Milanuncios" },
];

export type Listing = {
  id: string;
  title: string;
  description: string;
  price: number;
  category: string | null;
  brand: string | null;
  size: string | null;
  condition: string | null;
  photos: string[];
  status: "draft" | "active" | "sold" | "archived";
  created_at: string;
};

export type Publication = {
  id: string;
  listing_id: string;
  marketplace: Marketplace;
  external_url: string | null;
  status: "pending" | "published" | "sold" | "removed" | "error";
};
