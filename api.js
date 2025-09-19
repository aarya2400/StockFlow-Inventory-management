// alertsController.js
// Node/Express + Sequelize implementation for low-stock alerts
// Assumes: Sequelize is configured and models are defined as below.
// Note: adapt model file paths / sequelize instance to your project structure.

const express = require("express");
const router = express.Router();
const { Op, Sequelize } = require("sequelize");

// ---------- Models (skeletons) ----------
// You should already have these models defined in your project
// below are minimal definitions / shapes to make the controller logic clear.
//
// Product: id, company_id, sku, name, reorder_threshold (nullable), price, is_bundle
// Inventory: id, product_id, warehouse_id, quantity
// Warehouse: id, company_id, name
// Supplier: id, name, contact_info (JSON or columns like contact_email)
// SupplierProduct: supplier_id, product_id, priority (optional)
// Order: id, company_id, status, order_date
// OrderItem: id, order_id, product_id, quantity

// Replace these requires with your app's real model imports
const { Product, Inventory, Warehouse, Supplier, SupplierProduct, Order, OrderItem } = require("./models");
const sequelize = require("./sequelize"); // sequelize instance

// ---------- Configurable defaults ----------
const SALES_WINDOW_DAYS = 30;         // "recent" sales window
const DEFAULT_THRESHOLD = 20;         // fallback reorder threshold if none set on product

// Helper: safely parse int
function toNonNegInt(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * GET /api/companies/:companyId/alerts/low-stock
 * Returns an array of low-stock alerts complying with the expected response format.
 */
router.get("/api/companies/:companyId/alerts/low-stock", async (req, res) => {
  const companyId = parseInt(req.params.companyId, 10);
  if (!companyId) return res.status(400).json({ error: "invalid company id" });

  try {
    // 1) Compute recent sales per product for this company (windowed aggregation)
    // We use raw SQL for efficient aggregation. Adapt table names if different in your DB.
    const salesWindowDays = SALES_WINDOW_DAYS;
    const salesQuery = `
      SELECT oi.product_id, SUM(oi.quantity) AS sold_qty
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.company_id = :companyId
        AND o.status IN ('completed', 'shipped') -- treat these as real sales
        AND o.order_date >= NOW() - INTERVAL ':days DAY'
      GROUP BY oi.product_id
    `.replace(":days", String(salesWindowDays)); // sequelize doesn't allow interval param nicely in some drivers

    const [salesRows] = await sequelize.query(salesQuery, {
      replacements: { companyId },
      type: Sequelize.QueryTypes.SELECT
    });

    // Convert to map productId -> soldQty
    // Note: Sequelize returns array of rows; our SELECT returns objects
    const recentSalesMap = new Map();
    if (Array.isArray(salesRows)) {
      for (const row of salesRows) {
        // some DB clients return numeric strings; coerce to int
        const pid = Number(row.product_id);
        const qty = toNonNegInt(row.sold_qty, 0);
        recentSalesMap.set(pid, qty);
      }
    } else {
      // in some environments sequelize returns single row object; handle that
      // (if salesRows is a single object)
      if (salesRows && salesRows.product_id) {
        recentSalesMap.set(Number(salesRows.product_id), toNonNegInt(salesRows.sold_qty, 0));
      }
    }

    // If no products sold recently → return empty alerts
    if (recentSalesMap.size === 0) {
      return res.json({ alerts: [], total_alerts: 0 });
    }

    // 2) Fetch all inventories for products that belong to this company
    // We'll join Inventory -> Product -> Warehouse in Sequelize
    const inventories = await Inventory.findAll({
      include: [
        {
          model: Product,
          as: "product",
          where: { company_id: companyId }, // only company-scoped products
          attributes: ["id", "name", "sku", "reorder_threshold", "product_type"]
        },
        {
          model: Warehouse,
          as: "warehouse",
          attributes: ["id", "name"]
        }
      ],
      attributes: ["id", "product_id", "warehouse_id", "quantity"]
    });

    // 3) Filter inventory rows:
    // - product had recent sales (recentSalesMap has product_id)
    // - current_stock < threshold (product.reorder_threshold OR default)
    const candidates = [];
    for (const inv of inventories) {
      const product = inv.product;
      if (!product) continue; // should not happen
      const pid = product.id;

      // Only consider if product had recent sales
      const soldQty = recentSalesMap.get(pid) || 0;
      if (soldQty <= 0) continue;

      // Determine threshold: product.reorder_threshold or fallback
      const threshold = (product.reorder_threshold != null) ? toNonNegInt(product.reorder_threshold, DEFAULT_THRESHOLD) : DEFAULT_THRESHOLD;

      const currentStock = toNonNegInt(inv.quantity, 0);

      if (currentStock < threshold) {
        // compute avg daily sales & days_until_stockout
        const avgDailySales = soldQty / salesWindowDays; // float
        const daysUntilStockout = avgDailySales > 0 ? Math.ceil(currentStock / avgDailySales) : null;

        candidates.push({
          product_id: pid,
          product_name: product.name,
          sku: product.sku,
          warehouse_id: inv.warehouse_id,
          warehouse_name: inv.warehouse ? inv.warehouse.name : null,
          current_stock: currentStock,
          threshold,
          days_until_stockout: daysUntilStockout,
          // supplier to be filled later
          supplier: null
        });
      }
    }

    if (candidates.length === 0) {
      return res.json({ alerts: [], total_alerts: 0 });
    }

    // 4) Gather supplier info for all candidate products in one query
    const productIds = [...new Set(candidates.map(c => c.product_id))];

    // Get supplier mappings (choose first supplier per product)
    const supplierRows = await SupplierProduct.findAll({
      where: { product_id: { [Op.in]: productIds } },
      include: [{ model: Supplier, as: "supplier", attributes: ["id", "name", "contact_info"] }],
      order: [["priority", "ASC"]], // if you have priority column; otherwise arbitrary
      attributes: ["product_id", "supplier_id"]
    });

    // Build productId -> supplier mapping (pick first)
    const supplierMap = new Map();
    for (const row of supplierRows) {
      const pid = row.product_id;
      const sup = row.supplier;
      if (!supplierMap.has(pid) && sup) {
        // if contact_info is JSON { contact_email, phone } handle accordingly
        const email = sup.contact_info ? sup.contact_info.contact_email || sup.contact_info.email || null : null;
        supplierMap.set(pid, {
          id: sup.id,
          name: sup.name,
          contact_email: email
        });
      }
    }

    // 5) Attach supplier info to candidates
    for (const c of candidates) {
      c.supplier = supplierMap.get(c.product_id) || null;
    }

    // 6) Sort alerts by days_until_stockout ascending (most urgent first)
    candidates.sort((a, b) => {
      const da = a.days_until_stockout === null ? Number.MAX_SAFE_INTEGER : a.days_until_stockout;
      const db = b.days_until_stockout === null ? Number.MAX_SAFE_INTEGER : b.days_until_stockout;
      return da - db;
    });

    // Return response
    return res.json({
      alerts: candidates,
      total_alerts: candidates.length
    });
  } catch (err) {
    console.error("Error fetching low-stock alerts:", err);
    return res.status(500).json({ error: "internal server error" });
  }
});

module.exports = router;
