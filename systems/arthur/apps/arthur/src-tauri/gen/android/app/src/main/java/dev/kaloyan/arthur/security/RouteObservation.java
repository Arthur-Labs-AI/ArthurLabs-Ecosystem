package dev.kaloyan.arthur.security;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.*;
import android.os.Build;
import java.net.*;
import org.json.JSONObject;

/** Read-only, explicit snapshot. No callback registration, binding, DNS or sockets.
 * Application context is supplied by the existing native bootstrap. */
final class RouteObservation {
    private RouteObservation() {}
    private static String status(String value) {
        return "{\"status\":\"" + value + "\"}";
    }
    static String read(Context app, byte[] numeric, int scope) {
        if (numeric == null || (numeric.length != 4 && numeric.length != 16) || scope < 0)
            return status("incomplete");
        if (app.checkSelfPermission(Manifest.permission.ACCESS_NETWORK_STATE)
                != PackageManager.PERMISSION_GRANTED) return status("missing_permission");
        try {
            ConnectivityManager cm = app.getSystemService(ConnectivityManager.class);
            if (cm == null) return status("unsupported");
            Network network = cm.getActiveNetwork();
            if (network == null) return status("no_network");
            NetworkCapabilities caps = cm.getNetworkCapabilities(network);
            LinkProperties lp = cm.getLinkProperties(network);
            if (caps == null || lp == null || lp.getInterfaceName() == null)
                return status("changed");
            InetAddress destination = numeric.length == 16
                ? Inet6Address.getByAddress(null, numeric, scope) : InetAddress.getByAddress(numeric);
            NetworkInterface iface = NetworkInterface.getByName(lp.getInterfaceName());
            if (iface == null || iface.getIndex() <= 0) return status("incomplete");
            String medium = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) ? "vpn"
                : caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ? "cellular"
                : caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                    && !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ? "wifi"
                : caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
                    && !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ? "ethernet" : "unknown";
            RouteInfo route = null;
            for (RouteInfo r : lp.getRoutes()) {
                if (!r.getDestination().contains(destination)) continue;
                if (route == null || r.getDestination().getPrefixLength() > route.getDestination().getPrefixLength()) route = r;
                else if (r.getDestination().getPrefixLength() == route.getDestination().getPrefixLength()) return status("incomplete");
            }
            if (route == null || !lp.getInterfaceName().equals(route.getInterface())) return status("incomplete");
            if (Build.VERSION.SDK_INT < 29 || route.getType() != RouteInfo.RTN_UNICAST) return status("incomplete");
            // Without an eventual socket, multiple candidate source addresses
            // cannot be resolved by guessing Android's source-address policy.
            LinkAddress source = null;
            for (LinkAddress a : lp.getLinkAddresses()) {
                if (a.getAddress().getAddress().length != numeric.length) continue;
                if (!route.getDestination().contains(a.getAddress())) continue;
                if (source != null) return status("incomplete");
                source = a;
            }
            if (source == null || (destination.isLinkLocalAddress() && scope != iface.getIndex()))
                return status("incomplete");
            boolean broad = Build.VERSION.SDK_INT >= 37 && app.checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK") == PackageManager.PERMISSION_GRANTED;
            JSONObject out = new JSONObject();
            out.put("status","observed"); out.put("network",network.getNetworkHandle());
            out.put("interface",iface.getIndex()); out.put("medium",medium); out.put("up",iface.isUp());
            out.put("local",source.getAddress().getHostAddress().split("%",2)[0]); out.put("local_prefix",source.getPrefixLength());
            out.put("destination",route.getDestination().getAddress().getHostAddress().split("%",2)[0]);
            out.put("route_prefix",route.getDestination().getPrefixLength());
            out.put("gateway",route.hasGateway() ? route.getGateway().getHostAddress().split("%",2)[0] : "");
            // No NSD picker is implemented. Broad permission never implies a picker grant.
            out.put("broad",broad);
            // Actual pre-37 INTERNET model, separate from a broad API37 grant.
            // Only the isolated native qualification policy consumes this fact.
            out.put("legacy_internet",Build.VERSION.SDK_INT < 37
                && app.checkSelfPermission(Manifest.permission.INTERNET) == PackageManager.PERMISSION_GRANTED);
            if (!network.equals(cm.getActiveNetwork()) || !caps.equals(cm.getNetworkCapabilities(network))
                    || !lp.equals(cm.getLinkProperties(network))) return status("changed");
            if (app.checkSelfPermission(Manifest.permission.ACCESS_NETWORK_STATE) != PackageManager.PERMISSION_GRANTED
                    || broad != (Build.VERSION.SDK_INT >= 37 && app.checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK") == PackageManager.PERMISSION_GRANTED))
                return status("denied_or_revoked");
            return out.toString();
        } catch (SecurityException denied) { return status("denied_or_revoked"); }
        catch (Exception unavailable) { return status("incomplete"); }
    }
}
