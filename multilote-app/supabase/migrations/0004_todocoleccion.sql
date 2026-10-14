-- MultiLote: Todocolección como cuarto marketplace (coleccionistas y revendedores).
-- ADD VALUE va en su propia migración: el valor nuevo no se puede usar en la misma transacción.
alter type marketplace add value if not exists 'todocoleccion';
