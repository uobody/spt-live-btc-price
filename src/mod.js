const { request } = require("https");
const fs = require("fs");
const path = require("path");

class LBPR {
    static bitcoin = null;
    static logger = null;
    static config = null;
    static configPath = path.resolve(__dirname, "../config/config.json");
    static pricePath = path.resolve(__dirname, "../config/price.json");

    async postDBLoadAsync(container) {
        try {
            LBPR.logger = container.resolve("WinstonLogger");
            LBPR.loadConfig();
            
            const db = container.resolve("DatabaseServer");
            const handbook = db.getTables().templates.handbook;
            
            LBPR.bitcoin = handbook.Items.find(x => x.Id == "59faff1d86f7746c51718c9c");
            
            if (!LBPR.bitcoin) {
                LBPR.log("Physical Bitcoin not found in handbook!", "error");
                return;
            }

            LBPR.log(`LiveBTC initialized for PVE pricing`);
            LBPR.log(`Current Bitcoin price: ${LBPR.bitcoin.Price} RUB`);

            // Force cache deletion and fresh update on startup
            if (fs.existsSync(LBPR.pricePath)) {
                fs.unlinkSync(LBPR.pricePath);
            }

            // Always force update on startup
            LBPR.log("Updating Bitcoin price...");
            const updateResult = await LBPR.updatePrice();
            if (updateResult) {
                LBPR.log("Price updated successfully");
            } else {
                LBPR.log("Failed to update Bitcoin price", "error");
            }

            // Schedule periodic updates
            if (LBPR.config.enablePeriodicUpdates) {
                setInterval(() => LBPR.updatePrice(), LBPR.config.updateInterval * 1000);
                LBPR.log(`Updates scheduled every ${LBPR.config.updateInterval / 60} minutes`);
            }
            
        } catch (error) {
            console.error("LBPR initialization failed:", error);
        }
    }

    static loadConfig() {
        const configDir = path.dirname(LBPR.configPath);
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

        if (!fs.existsSync(LBPR.configPath)) {
            const defaultConfig = {
                updateInterval: 2700,
                enableLogging: true,
                enableStartupUpdate: true,
                enablePeriodicUpdates: true,
                forceStartupUpdate: true,
                advanced: {
                    enablePriceCaching: true,
                    enableDetailedLogging: false,
                    apiTimeout: 15000,
                    userAgent: "SPT-LiveBTC-PVE"
                }
            };
            fs.writeFileSync(LBPR.configPath, JSON.stringify(defaultConfig, null, 4));
        }

        try {
            LBPR.config = JSON.parse(fs.readFileSync(LBPR.configPath, "utf-8"));
            // Ensure critical settings
            LBPR.config.forceStartupUpdate = true;
        } catch (e) {
            console.error("Failed to load config:", e.message);
            LBPR.config = {
                updateInterval: 2700,
                enableLogging: true,
                forceStartupUpdate: true,
                advanced: {
                    enablePriceCaching: true,
                    enableDetailedLogging: false,
                    apiTimeout: 15000,
                    userAgent: "SPT-LiveBTC-PVE"
                }
            };
        }
    }

    static log(message, type = "info") {
        if (!LBPR.config?.enableLogging) return;
        if (LBPR.logger && LBPR.logger[type]) {
            LBPR.logger[type](message);
        } else {
            console.log(`[${type.toUpperCase()}] ${message}`);
        }
    }

    static async updatePrice() {
        return new Promise((resolve) => {
            // Simplified query - only fetch basePrice since others are null for PVE
            const query = `query { items(gameMode: pve, name: "Physical Bitcoin") { basePrice } }`;
            
            const req = request("https://api.tarkov.dev/graphql", {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': LBPR.config.advanced?.userAgent || "SPT-LiveBTC-PVE"
                },
                timeout: LBPR.config.advanced?.apiTimeout || 15000
            }, (res) => {
                let data = "";
                res.on("data", chunk => data += chunk);
                res.on("end", () => {
                    try {
                        const response = JSON.parse(data);
                        if (response.errors || !response.data?.items?.[0]) {
                            LBPR.log("Failed to fetch Bitcoin price data", "error");
                            resolve(false);
                            return;
                        }

                        const item = response.data.items[0];
                        
                        // Use basePrice directly since it's the only valid price for PVE
                        const newPrice = item.basePrice;
                        
                        if (!newPrice || newPrice <= 0) {
                            LBPR.log("Invalid price received from API", "error");
                            resolve(false);
                            return;
                        }

                        const oldPrice = LBPR.bitcoin.Price;
                        LBPR.bitcoin.Price = Math.floor(newPrice);
                        
                        const diff = LBPR.bitcoin.Price - oldPrice;
                        LBPR.log(`Bitcoin (PVE): ${oldPrice} → ${LBPR.bitcoin.Price} RUB (${diff > 0 ? '+' : ''}${diff})`);

                        if (LBPR.config.advanced?.enableDetailedLogging) {
                            LBPR.log(`Base price: ${item.basePrice} RUB`);
                        }

                        // Cache price
                        if (LBPR.config.advanced?.enablePriceCaching) {
                            const cacheData = {
                                [LBPR.bitcoin.Id]: LBPR.bitcoin.Price,
                                gameMode: "pve",
                                lastUpdate: Math.floor(Date.now() / 1000),
                                basePrice: item.basePrice
                            };
                            fs.writeFileSync(LBPR.pricePath, JSON.stringify(cacheData, null, 2));
                        }

                        // Update config
                        LBPR.config.nextUpdate = Math.floor(Date.now() / 1000) + LBPR.config.updateInterval;
                        fs.writeFileSync(LBPR.configPath, JSON.stringify(LBPR.config, null, 4));
                        
                        resolve(true);
                    } catch (e) {
                        LBPR.log(`Error parsing API response: ${e.message}`, "error");
                        resolve(false);
                    }
                });
            });

            req.on("error", e => {
                LBPR.log(`API error: ${e.message}`, "error");
                resolve(false);
            });

            req.on("timeout", () => {
                LBPR.log("API request timeout", "error");
                req.destroy();
                resolve(false);
            });

            req.write(JSON.stringify({ query }));
            req.end();
        });
    }
}

module.exports = { mod: new LBPR() };