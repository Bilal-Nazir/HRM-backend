// Runs only when the Mongo data volume is first initialized.
db.getSiblingDB("hrm").createUser({
  user: "hrm",
  pwd: process.env.MONGO_APP_PASSWORD,
  roles: [
    { role: "readWrite", db: "hrm" },
    { role: "readWrite", db: "hrm-prod" },
  ],
});
