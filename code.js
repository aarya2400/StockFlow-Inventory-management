// imports
const express = require("express");
const { Sequelize, DataTypes, Transaction } = require("sequelize");
const Decimal = require("decimal.js");

// setup express
const app = express();
app.use(express.json());

// setup sequelize (Postgres for example)
const sequelize = new Sequelize(process.env.DB_URL);

// models
const Product = sequelize.define("Product", {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  sku: { type: DataTypes.STRING, allowNull: false, unique: true },
  name: { type: DataTypes.STRING, allowNull: false },
  price: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0.0 }
});

const Warehouse = sequelize.define("Warehouse", {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false }
});

const Inventory = sequelize.define("Inventory", {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
});

// relations
Product.hasMany(Inventory, { foreignKey: "product_id" });
Inventory.belongsTo(Product, { foreignKey: "product_id" });
Warehouse.hasMany(Inventory, { foreignKey: "warehouse_id" });
Inventory.belongsTo(Warehouse, { foreignKey: "warehouse_id" });

// route
app.post("/api/products", async (req, res) => {
  const { sku, name, warehouse_id, initial_quantity = 0, price } = req.body;

  if (!sku || !name || warehouse_id === undefined) {
    return res.status(400).json({ error: "sku, name, and warehouse_id are required" });
  }

  let parsedPrice;
  try {
    parsedPrice = price ? new Decimal(price).toFixed(2) : "0.00";
    if (new Decimal(parsedPrice).isNegative()) {
      return res.status(400).json({ error: "price must be non-negative" });
    }
  } catch {
    return res.status(400).json({ error: "invalid price format" });
  }

  let parsedQuantity = parseInt(initial_quantity, 10);
  if (isNaN(parsedQuantity) || parsedQuantity < 0) {
    return res.status(400).json({ error: "initial_quantity must be a non-negative integer" });
  }

  const t = await sequelize.transaction();
  try {
    let product = await Product.findOne({ where: { sku }, transaction: t, lock: t.LOCK.UPDATE });
    if (product) {
      // update product fields if allowed
      if (name) product.name = name;
      if (price !== undefined) product.price = parsedPrice;
      await product.save({ transaction: t });

      let inv = await Inventory.findOne({
        where: { product_id: product.id, warehouse_id },
        transaction: t,
        lock: t.LOCK.UPDATE
      });

      if (inv) {
        inv.quantity += parsedQuantity;
        await inv.save({ transaction: t });
      } else {
        await Inventory.create({ product_id: product.id, warehouse_id, quantity: parsedQuantity }, { transaction: t });
      }

      await t.commit();
      return res.status(200).json({ message: "Existing product - inventory updated", product_id: product.id });
    }

    // Create new product
    product = await Product.create({ sku, name, price: parsedPrice }, { transaction: t });
    await Inventory.create({ product_id: product.id, warehouse_id, quantity: parsedQuantity }, { transaction: t });

    await t.commit();
    return res.status(201).json({ message: "Product created", product_id: product.id });
  } catch (err) {
    await t.rollback();
    console.error("Error in create_product:", err);
    return res.status(500).json({ error: "internal server error" });
  }
});

// run server
app.listen(3000, () => console.log("Server running on port 3000"));
