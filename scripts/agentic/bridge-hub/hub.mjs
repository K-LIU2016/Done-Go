// bridge-hub 组合工厂。部署层负责把返回的 HTTP/WSS 回调挂到现有服务端。
import { createPairingService } from './pairing.mjs';
import { createDeviceRegistry } from './devices.mjs';
import { createBridgeRoutes } from './routes.mjs';

export function createBridgeHub({ db, auth, wss, ...options } = {}) {
  const pairing = createPairingService({ db, now: options.now });
  const devices = createDeviceRegistry({ db, now: options.now });
  const routes = createBridgeRoutes({ db, auth, wss, pairing, devices, ...options });
  return { pairing, devices, routes };
}
