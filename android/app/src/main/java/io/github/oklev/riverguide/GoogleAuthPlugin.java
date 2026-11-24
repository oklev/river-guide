package io.github.oklev.riverguide;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.Scope;

import java.util.ArrayList;
import java.util.List;

/**
 * Google access tokens via Android's own account picker (Google Identity
 * AuthorizationClient). Google doesn't allow its sign-in page inside app
 * WebViews, so the web app asks for tokens through this plugin instead.
 *
 * The app is recognised by its package name and signing certificate, which
 * must be registered as an "Android" OAuth client in the same Google Cloud
 * project as the web client.
 *
 *   authorize({scopes, interactive}) -> {accessToken}
 *     interactive=false never shows UI: rejects with NEEDS_USER_ACTION instead.
 */
@CapacitorPlugin(name = "GoogleAuth")
public class GoogleAuthPlugin extends Plugin {
    private ActivityResultLauncher<IntentSenderRequest> launcher;
    private PluginCall pending;

    @Override
    public void load() {
        // Must be registered before the activity starts; plugins load during onCreate.
        launcher = getActivity().registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), result -> {
            PluginCall call = pending;
            pending = null;
            if (call == null) return;
            try {
                AuthorizationResult r = Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(result.getData());
                resolve(call, r);
            } catch (Exception e) {
                call.reject("Google sign-in was cancelled", "CANCELLED");
            }
        });
    }

    private void resolve(PluginCall call, AuthorizationResult r) {
        if (r.getAccessToken() == null) {
            call.reject("Google didn't return an access token");
            return;
        }
        JSObject o = new JSObject();
        o.put("accessToken", r.getAccessToken());
        call.resolve(o);
    }

    @PluginMethod
    public void authorize(PluginCall call) {
        JSArray raw = call.getArray("scopes", new JSArray());
        boolean interactive = Boolean.TRUE.equals(call.getBoolean("interactive", false));
        List<Scope> scopes = new ArrayList<>();
        try {
            for (int i = 0; i < raw.length(); i++) scopes.add(new Scope(raw.getString(i)));
        } catch (Exception e) {
            call.reject("Bad scopes");
            return;
        }
        AuthorizationRequest request = AuthorizationRequest.builder().setRequestedScopes(scopes).build();
        Identity.getAuthorizationClient(getActivity())
            .authorize(request)
            .addOnSuccessListener(r -> {
                if (!r.hasResolution()) {
                    resolve(call, r);
                    return;
                }
                // Google needs the user: pick an account and/or consent.
                if (!interactive || r.getPendingIntent() == null) {
                    call.reject("Google needs you to sign in again", "NEEDS_USER_ACTION");
                    return;
                }
                if (pending != null) pending.reject("Superseded by a newer sign-in request", "CANCELLED");
                pending = call;
                launcher.launch(new IntentSenderRequest.Builder(r.getPendingIntent().getIntentSender()).build());
            })
            .addOnFailureListener(e -> call.reject("Google sign-in failed: " + e.getMessage()));
    }

    @PluginMethod
    public void signOut(PluginCall call) {
        // Tokens expire on their own; access can be fully removed at myaccount.google.com › Security › Third-party apps.
        call.resolve();
    }
}
