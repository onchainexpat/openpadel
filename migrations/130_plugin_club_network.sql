-- One address on the club's own network a local plugin may reach (packages/core/src/club_network.ts): the IP its
-- club-network setting named when the owner said yes, which its service (openpadel plugin service) lets through.
-- Null: nothing on the club's network.
alter table plugin add column club_network_ip text;
