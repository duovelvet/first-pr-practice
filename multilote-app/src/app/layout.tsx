import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MultiLote — Publica en Wallapop, Vinted, Milanuncios y Todocolección a la vez",
  description:
    "Cross-listing para vendedores en España: crea tu anuncio una vez y publícalo en todos los marketplaces. Más simple y barato que las alternativas.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
