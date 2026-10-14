export type Marketplace = "wallapop" | "vinted" | "milanuncios" | "todocoleccion";

export const MARKETPLACES: { id: Marketplace; name: string }[] = [
  { id: "wallapop", name: "Wallapop" },
  { id: "vinted", name: "Vinted" },
  { id: "milanuncios", name: "Milanuncios" },
  { id: "todocoleccion", name: "Todocolección" },
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

export type SyncJob = {
  id: string;
  listing_id: string;
  marketplace: Marketplace;
  action: "publish" | "update" | "delete";
  status: "pending" | "processing" | "done" | "failed";
  attempts: number;
  last_error: string | null;
  external_url: string | null;
  run_after: string;
  created_at: string;
};
