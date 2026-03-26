
DELETE FROM item_master a USING item_master b
WHERE a.id > b.id AND a.upc = b.upc AND a.model_number = b.model_number;
