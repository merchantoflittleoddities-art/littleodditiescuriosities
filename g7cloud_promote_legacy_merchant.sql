UPDATE customers
SET role = 'merchant'
WHERE email = 'merchant.of.littleoddities@gmail.com'
  AND role <> 'merchant';

SELECT id, name, email, role
FROM customers
WHERE email = 'merchant.of.littleoddities@gmail.com';