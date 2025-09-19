// GET /api/companies/:companyId/alerts/low-stock
router.get('/api/companies/:companyId/alerts/low-stock', async (req, res) => {
  const { companyId } = req.params;

  try {
    // Step 1: Fetch products, warehouses, suppliers, and stock
    const alerts = await Product.findAll({
      include: [
        {
          model: Supplier,
          attributes: ['id', 'name', 'contact_email']
        },
        {
          model: StockLevel,
          include: [
            {
              model: Warehouse,
              attributes: ['id', 'name'],
              where: { company_id: companyId } // multi-tenant filter
            }
          ]
        }
      ],
      attributes: ['id', 'name', 'sku', 'threshold'],
    });

    // Step 2: Check stock against threshold & recent sales
    const results = [];
    for (const product of alerts) {
      for (const stock of product.StockLevels) {
        // Default threshold if missing
        const threshold = product.threshold || 10;

        // Current stock
        const currentStock = stock.quantity || 0;

        // Skip if above threshold
        if (currentStock >= threshold) continue;

        // Step 3: Check recent sales activity (last 30 days)
        const recentSales = await Sale.count({
          where: {
            product_id: product.id,
            warehouse_id: stock.Warehouse.id,
            sale_date: {
              [Op.gte]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
            }
          }
        });

        if (recentSales === 0) continue; // no recent activity → skip

        // Step 4: Calculate days until stockout
        const avgDailySales = recentSales / 30 || 1;
        const daysUntilStockout = Math.floor(currentStock / avgDailySales);

        // Step 5: Push alert
        results.push({
          product_id: product.id,
          product_name: product.name,
          sku: product.sku,
          warehouse_id: stock.Warehouse.id,
          warehouse_name: stock.Warehouse.name,
          current_stock: currentStock,
          threshold,
          days_until_stockout: daysUntilStockout,
          supplier: product.Supplier ? {
            id: product.Supplier.id,
            name: product.Supplier.name,
            contact_email: product.Supplier.contact_email
          } : null
        });
      }
    }

    return res.json({
      alerts: results,
      total_alerts: results.length
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

