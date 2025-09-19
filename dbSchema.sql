-- StockFlow DB Schema (PostgreSQL)
BEGIN;

-- helper: function to auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- 1. companies
CREATE TABLE IF NOT EXISTS companies (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_companies_set_updated_at
BEFORE UPDATE ON companies
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- 2. warehouses
CREATE TABLE IF NOT EXISTS warehouses (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    location TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, name)
);

CREATE TRIGGER trg_warehouses_set_updated_at
BEFORE UPDATE ON warehouses
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- 3. suppliers
CREATE TABLE IF NOT EXISTS suppliers (
    id BIGSERIAL PRIMARY KEY,
    -- supplier global name uniqueness assumed; if suppliers are per-company, add company_id FK
    name VARCHAR(255) NOT NULL UNIQUE,
    contact_info JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_suppliers_set_updated_at
BEFORE UPDATE ON suppliers
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- 4. products
CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    sku VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    is_bundle BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, sku)
);

CREATE TRIGGER trg_products_set_updated_at
BEFORE UPDATE ON products
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- 5. product_bundles (self-referencing many-to-many)
CREATE TABLE IF NOT EXISTS product_bundles (
    bundle_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    component_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INT NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (bundle_id, component_id),
    CHECK (bundle_id <> component_id) -- prevent self-reference
);

-- 6. inventory (product <-> warehouse)
CREATE TABLE IF NOT EXISTS inventory (
    id BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    quantity INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (product_id, warehouse_id)
);

CREATE TRIGGER trg_inventory_set_updated_at
BEFORE UPDATE ON inventory
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- 7. inventory_audit (audit/history)
CREATE TABLE IF NOT EXISTS inventory_audit (
    id BIGSERIAL PRIMARY KEY,
    inventory_id BIGINT NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
    old_quantity INT NOT NULL,
    new_quantity INT NOT NULL,
    change_amount INT NOT NULL, -- new_quantity - old_quantity
    reason VARCHAR(255),
    changed_by BIGINT, -- optional: link to users table if added later
    changed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 8. supplier_products (many-to-many between suppliers and products)
CREATE TABLE IF NOT EXISTS supplier_products (
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    lead_time_days INT CHECK (lead_time_days >= 0),
    min_order_quantity INT CHECK (min_order_quantity >= 0),
    PRIMARY KEY (supplier_id, product_id)
);

-- Indexes for performance (some covered by uniques/pks, but explicit for common lookups)
CREATE INDEX IF NOT EXISTS idx_products_company_sku ON products (company_id, sku);
CREATE INDEX IF NOT EXISTS idx_inventory_prod_wh ON inventory (product_id, warehouse_id);
CREATE INDEX IF NOT EXISTS idx_inventory_wh ON inventory (warehouse_id);
CREATE INDEX IF NOT EXISTS idx_inventory_audit_inventory_time ON inventory_audit (inventory_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_supplier_products_product ON supplier_products (product_id);

COMMIT;

-- Optional: sample comment block explaining usage
COMMENT ON TABLE products IS 'Products are scoped to a company; sku is unique per company.';
COMMENT ON TABLE inventory IS 'Current inventory per product per warehouse. Use inventory_audit for history.';

