# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# The page calls into MainActivity's bridges by name (addJavascriptInterface). Nothing in the Kotlin calls
# them, so the shrinker would take them for unused: a release build would start, then open no file handed
# to it and finish no sign-in.
-keepclassmembers class com.notex.app.MainActivity$* {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.notex.app.MainActivity$* { *; }
-keepattributes *Annotation*
