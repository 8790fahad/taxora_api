'use strict';

module.exports = (sequelize, DataTypes) => {
  const Tenant = sequelize.define(
    'Tenant',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      legal_name: DataTypes.STRING,
      tin: DataTypes.STRING,
      rc_number: { type: DataTypes.STRING, unique: true },
      primary_phone: DataTypes.STRING,
      state: DataTypes.STRING,
      company_classification: DataTypes.STRING,
      incorporation_date: DataTypes.DATEONLY,
      address: DataTypes.TEXT,
      address_line: DataTypes.STRING,
      address_city: DataTypes.STRING,
      address_country: { type: DataTypes.STRING(2), defaultValue: 'NG' },
      address_postal_zone: DataTypes.STRING,
      nrs_business_id: DataTypes.STRING,
      nrs_service_id: DataTypes.STRING,
      // Company logo stored as a data URL (base64). TEXT so it fits inline.
      logo_url: DataTypes.TEXT,
      logo_width: DataTypes.INTEGER,
      logo_height: DataTypes.INTEGER,
      // Profile (company) verification. CAC-verified signups are auto-approved;
      // manual signups stay 'pending_review' until an admin approves them, which
      // then releases the email-verification link to the user.
      profile_status: {
        type: DataTypes.ENUM('verified', 'pending_review'),
        allowNull: false,
        defaultValue: 'verified',
      },
      verification_method: DataTypes.STRING,
      profile_verified_at: DataTypes.DATE,
      wallet_balance_ngn: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      status: {
        type: DataTypes.ENUM(
          'DRAFT',
          'REGISTERED',
          'ERP_CONNECTED',
          'SUBSCRIBED',
          'ACTIVE',
          'SUSPENDED',
          'CANCELLED'
        ),
        allowNull: false,
        defaultValue: 'DRAFT',
      },
      onboarding: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: { register: false, erp: false, subscribe: false },
      },
    },
    {
      tableName: 'tenants',
      underscored: true,
    }
  );

  Tenant.associate = (models) => {
    Tenant.belongsToMany(models.User, {
      through: models.TenantUser,
      foreignKey: 'tenant_id',
      otherKey: 'user_id',
    });
    Tenant.hasMany(models.TenantUser, { foreignKey: 'tenant_id' });
    Tenant.hasMany(models.ErpConnection, { foreignKey: 'tenant_id' });
    Tenant.hasMany(models.Subscription, { foreignKey: 'tenant_id' });
    Tenant.hasMany(models.Invoice, { foreignKey: 'tenant_id' });
    Tenant.hasMany(models.ProductMapping, { foreignKey: 'tenant_id' });
  };

  return Tenant;
};
