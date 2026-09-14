package app.jconnect.android;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(DevicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
